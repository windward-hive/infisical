import { TSecretApprovalPolicyServiceFactory } from "@app/ee/services/secret-approval-policy/secret-approval-policy-service";
import { TSecretApprovalRequestDALFactory } from "@app/ee/services/secret-approval-request/secret-approval-request-dal";
import { TSecretApprovalRequestSecretDALFactory } from "@app/ee/services/secret-approval-request/secret-approval-request-secret-dal";
import { TSecretSnapshotServiceFactory } from "@app/ee/services/secret-snapshot/secret-snapshot-service";
import { KeyStorePrefixes, TKeyStoreFactory } from "@app/keystore/keystore";
import { BadRequestError } from "@app/lib/errors";
import { groupBy } from "@app/lib/fn";
import { logger } from "@app/lib/logger";
import { alphaNumericNanoId } from "@app/lib/nanoid";
import { QueueName, TQueueServiceFactory } from "@app/queue";
import { ActorType } from "@app/services/auth/auth-type";
import { TProjectMembershipDALFactory } from "@app/services/project-membership/project-membership-dal";
import { TSecretDALFactory } from "@app/services/secret/secret-dal";
import { fnSecretBulkInsert, fnSecretBulkUpdate } from "@app/services/secret/secret-fns";
import { TSecretQueueFactory } from "@app/services/secret/secret-queue";
import { SecretOperations, TSyncSecretsDTO } from "@app/services/secret/secret-types";
import { TSecretVersionDALFactory } from "@app/services/secret/secret-version-dal";
import { TSecretVersionTagDALFactory } from "@app/services/secret/secret-version-tag-dal";
import { TSecretBlindIndexDALFactory } from "@app/services/secret-blind-index/secret-blind-index-dal";
import { TSecretFolderDALFactory } from "@app/services/secret-folder/secret-folder-dal";
import { TSecretImportDALFactory } from "@app/services/secret-import/secret-import-dal";
import { TSecretTagDALFactory } from "@app/services/secret-tag/secret-tag-dal";

import { TSecretReplicationDALFactory } from "./secret-replication-dal";

type TSecretReplicationServiceFactoryDep = {
  secretReplicationDAL: TSecretReplicationDALFactory;
  secretDAL: Pick<
    TSecretDALFactory,
    "find" | "findByBlindIndexes" | "insertMany" | "bulkUpdate" | "delete" | "upsertSecretReferences"
  >;
  secretVersionDAL: Pick<TSecretVersionDALFactory, "find" | "insertMany" | "update" | "findLatestVersionMany">;
  secretImportDAL: Pick<TSecretImportDALFactory, "find" | "updateById">;
  folderDAL: Pick<TSecretFolderDALFactory, "findSecretPathByFolderIds" | "findBySecretPath">;
  secretVersionTagDAL: Pick<TSecretVersionTagDALFactory, "find" | "insertMany">;
  secretQueueService: Pick<TSecretQueueFactory, "syncSecrets">;
  snapshotService: Pick<TSecretSnapshotServiceFactory, "performSnapshot">;
  queueService: Pick<TQueueServiceFactory, "start" | "listen" | "queue" | "stopJobById">;
  secretApprovalPolicyService: Pick<TSecretApprovalPolicyServiceFactory, "getSecretApprovalPolicy">;
  keyStore: Pick<TKeyStoreFactory, "acquireLock" | "setItemWithExpiry" | "getItem">;
  secretBlindIndexDAL: Pick<TSecretBlindIndexDALFactory, "findOne">;
  secretTagDAL: Pick<TSecretTagDALFactory, "findManyTagsById" | "saveTagsToSecret" | "deleteTagsManySecret" | "find">;
  secretApprovalRequestDAL: Pick<TSecretApprovalRequestDALFactory, "create" | "transaction">;
  projectMembershipDAL: Pick<TProjectMembershipDALFactory, "findOne">;
  secretApprovalRequestSecretDAL: Pick<
    TSecretApprovalRequestSecretDALFactory,
    "insertMany" | "insertApprovalSecretTags"
  >;
};

export type TSecretReplicationServiceFactory = ReturnType<typeof secretReplicationServiceFactory>;
const SECRET_IMPORT_SUCCESS_LOCK = 10;
const keystoreReplicationSuccessKey = (jobId: string, secretImportId: string) => `${jobId}-${secretImportId}`;
const getReplicationKeyLockPrefix = (keyName: string) => `REPLICATION_SECRET_${keyName}`;

export const secretReplicationServiceFactory = ({
  secretReplicationDAL,
  secretDAL,
  queueService,
  secretVersionDAL,
  secretImportDAL,
  keyStore,
  secretVersionTagDAL,
  secretTagDAL,
  folderDAL,
  secretApprovalPolicyService,
  secretApprovalRequestSecretDAL,
  secretApprovalRequestDAL,
  secretQueueService,
  snapshotService,
  projectMembershipDAL
}: TSecretReplicationServiceFactoryDep) => {
  queueService.start(QueueName.SecretReplication, async (job) => {
    logger.info(job.data, "Replication started");
    const {
      secrets,
      folderId,
      secretPath,
      environmentId,
      projectId,
      actorId,
      actor,
      pickOnlyImportIds,
      _deDupeReplicationQueue: deDupeReplicationQueue,
      _deDupeQueue: deDupeQueue
    } = job.data;

    // filter for  initial filling
    let secretImports = await secretImportDAL.find({
      importPath: secretPath,
      importEnv: environmentId,
      isReplication: true
    });
    secretImports = pickOnlyImportIds
      ? secretImports.filter(({ id }) => pickOnlyImportIds?.includes(id))
      : secretImports;
    if (!secretImports.length || !secrets.length) return;

    // unfiltered secrets to be replicated
    const toBeReplicatedSecrets = await secretReplicationDAL.findSecretVersions({ folderId, secrets });
    const replicatedSecrets = toBeReplicatedSecrets.filter(
      ({ version, latestReplicatedVersion, secretBlindIndex }) =>
        secretBlindIndex && (version === 1 || latestReplicatedVersion <= version)
    );
    const replicatedSecretsGroupBySecretId = groupBy(replicatedSecrets, (i) => i.secretId);
    // this is to filter out personal secrets
    const sanitizedSecrets = secrets.filter(({ id }) => Object.hasOwn(replicatedSecretsGroupBySecretId, id));
    if (!sanitizedSecrets.length) return;

    const lock = await keyStore.acquireLock(
      replicatedSecrets.map(({ id }) => getReplicationKeyLockPrefix(id)),
      5000
    );

    try {
      /*  eslint-disable no-await-in-loop */
      for (const secretImport of secretImports) {
        try {
          const hasJobCompleted = await keyStore.getItem(
            keystoreReplicationSuccessKey(job.id as string, secretImport.id),
            KeyStorePrefixes.SecretReplication
          );
          if (hasJobCompleted) {
            logger.info(
              { jobId: job.id, importId: secretImport.id },
              "Skipping this job as this has been successfully replicated."
            );
            // eslint-disable-next-line
            continue;
          }

          const [importedFolder] = await folderDAL.findSecretPathByFolderIds(projectId, [secretImport.folderId]);
          if (!importedFolder) throw new BadRequestError({ message: "Imported folder not found" });
          const importFolderId = importedFolder.id;

          const localSecrets = await secretDAL.find({
            $in: { secretBlindIndex: replicatedSecrets.map(({ secretBlindIndex }) => secretBlindIndex) },
            folderId: importFolderId
          });
          const localSecretsGroupedByBlindIndex = groupBy(localSecrets, (i) => i.secretBlindIndex as string);

          const locallyCreatedSecrets = sanitizedSecrets
            .filter(
              ({ operation, id }) =>
                // upsert: irrespective of create or update its a create if not  found in dashboard
                (operation === SecretOperations.Create || operation === SecretOperations.Update) &&
                !localSecretsGroupedByBlindIndex[
                  replicatedSecretsGroupBySecretId[id][0].secretBlindIndex as string
                ]?.[0]
            )
            .map((el) => ({ ...el, operation: SecretOperations.Create })); // rewrite update ops to create

          const locallyUpdatedSecrets = sanitizedSecrets
            .filter(
              ({ operation, id }) =>
                // upsert: irrespective of create or update its an update if not  found in dashboard
                (operation === SecretOperations.Create || operation === SecretOperations.Update) &&
                localSecretsGroupedByBlindIndex[replicatedSecretsGroupBySecretId[id][0].secretBlindIndex as string]?.[0]
            )
            .map((el) => ({ ...el, operation: SecretOperations.Update })); // rewrite create ops to update

          const locallyDeletedSecrets = sanitizedSecrets.filter(
            ({ operation, id }) =>
              operation === SecretOperations.Delete &&
              Boolean(replicatedSecretsGroupBySecretId[id]?.[0]?.secretBlindIndex) &&
              localSecretsGroupedByBlindIndex[replicatedSecretsGroupBySecretId[id][0].secretBlindIndex as string]?.[0]
          );

          const policy = await secretApprovalPolicyService.getSecretApprovalPolicy(
            projectId,
            importedFolder.environmentSlug,
            importedFolder.path
          );
          // this means it should be a approval request rather than direct replication
          if (policy && actor === ActorType.USER) {
            const membership = await projectMembershipDAL.findOne({ projectId, userId: actorId });
            if (!membership) {
              logger.error("Project membership not found in %s for user %s", projectId, actorId);
              return;
            }

            const localSecretsLatestVersions = localSecrets.map(({ id }) => id);
            const latestSecretVersions = await secretVersionDAL.findLatestVersionMany(
              importFolderId,
              localSecretsLatestVersions
            );
            await secretApprovalRequestDAL.transaction(async (tx) => {
              const approvalRequestDoc = await secretApprovalRequestDAL.create(
                {
                  folderId: importFolderId,
                  slug: alphaNumericNanoId(),
                  policyId: policy.id,
                  status: "open",
                  hasMerged: false,
                  committerId: membership.id,
                  isReplicated: true
                },
                tx
              );
              const commits = locallyCreatedSecrets
                .concat(locallyUpdatedSecrets)
                .concat(locallyDeletedSecrets)
                .map(({ id, operation }) => {
                  const doc = replicatedSecretsGroupBySecretId[id][0];
                  const localSecret = localSecretsGroupedByBlindIndex[doc.secretBlindIndex as string]?.[0];

                  return {
                    op: operation,
                    keyEncoding: doc.keyEncoding,
                    algorithm: doc.algorithm,
                    requestId: approvalRequestDoc.id,
                    metadata: doc.metadata,
                    secretKeyIV: doc.secretKeyIV,
                    secretKeyTag: doc.secretKeyTag,
                    secretKeyCiphertext: doc.secretKeyCiphertext,
                    secretValueIV: doc.secretValueIV,
                    secretValueTag: doc.secretValueTag,
                    secretValueCiphertext: doc.secretValueCiphertext,
                    secretBlindIndex: doc.secretBlindIndex,
                    secretCommentIV: doc.secretCommentIV,
                    secretCommentTag: doc.secretCommentTag,
                    secretCommentCiphertext: doc.secretCommentCiphertext,
                    isReplicated: true,
                    skipMultilineEncoding: doc.skipMultilineEncoding,
                    // except create operation other two needs the secret id and version id
                    ...(operation !== SecretOperations.Create
                      ? { secretId: localSecret.id, secretVersion: latestSecretVersions[localSecret.id].id }
                      : {})
                  };
                });
              const approvalCommits = await secretApprovalRequestSecretDAL.insertMany(commits, tx);

              return { ...approvalRequestDoc, commits: approvalCommits };
            });
          } else {
            let nestedImportSecrets: TSyncSecretsDTO["secrets"] = [];
            await secretReplicationDAL.transaction(async (tx) => {
              if (locallyCreatedSecrets.length) {
                const newSecrets = await fnSecretBulkInsert({
                  folderId: importFolderId,
                  secretVersionDAL,
                  secretDAL,
                  tx,
                  secretTagDAL,
                  secretVersionTagDAL,
                  inputSecrets: locallyCreatedSecrets.map(({ id }) => {
                    const doc = replicatedSecretsGroupBySecretId[id][0];
                    return {
                      keyEncoding: doc.keyEncoding,
                      algorithm: doc.algorithm,
                      type: doc.type,
                      metadata: doc.metadata,
                      secretKeyIV: doc.secretKeyIV,
                      secretKeyTag: doc.secretKeyTag,
                      secretKeyCiphertext: doc.secretKeyCiphertext,
                      secretValueIV: doc.secretValueIV,
                      secretValueTag: doc.secretValueTag,
                      secretValueCiphertext: doc.secretValueCiphertext,
                      secretBlindIndex: doc.secretBlindIndex,
                      secretCommentIV: doc.secretCommentIV,
                      secretCommentTag: doc.secretCommentTag,
                      secretCommentCiphertext: doc.secretCommentCiphertext,
                      isReplicated: true,
                      skipMultilineEncoding: doc.skipMultilineEncoding
                    };
                  })
                });
                nestedImportSecrets = nestedImportSecrets.concat(
                  newSecrets.map(({ id, version }) => ({ operation: SecretOperations.Create, version, id }))
                );
              }
              if (locallyUpdatedSecrets.length) {
                const newSecrets = await fnSecretBulkUpdate({
                  projectId,
                  folderId: importFolderId,
                  secretVersionDAL,
                  secretDAL,
                  tx,
                  secretTagDAL,
                  secretVersionTagDAL,
                  inputSecrets: locallyUpdatedSecrets.map(({ id }) => {
                    const doc = replicatedSecretsGroupBySecretId[id][0];
                    return {
                      filter: {
                        folderId: importFolderId,
                        id: localSecretsGroupedByBlindIndex[doc.secretBlindIndex as string][0].id
                      },
                      data: {
                        keyEncoding: doc.keyEncoding,
                        algorithm: doc.algorithm,
                        type: doc.type,
                        metadata: doc.metadata,
                        secretKeyIV: doc.secretKeyIV,
                        secretKeyTag: doc.secretKeyTag,
                        secretKeyCiphertext: doc.secretKeyCiphertext,
                        secretValueIV: doc.secretValueIV,
                        secretValueTag: doc.secretValueTag,
                        secretValueCiphertext: doc.secretValueCiphertext,
                        secretBlindIndex: doc.secretBlindIndex,
                        secretCommentIV: doc.secretCommentIV,
                        secretCommentTag: doc.secretCommentTag,
                        secretCommentCiphertext: doc.secretCommentCiphertext,
                        isReplicated: true,
                        skipMultilineEncoding: doc.skipMultilineEncoding
                      }
                    };
                  })
                });
                nestedImportSecrets = nestedImportSecrets.concat(
                  newSecrets.map(({ id, version }) => ({ operation: SecretOperations.Update, version, id }))
                );
              }
              if (locallyDeletedSecrets.length) {
                const newSecrets = await secretDAL.delete(
                  {
                    $in: {
                      id: locallyDeletedSecrets.map(({ id }) => id)
                    },
                    isReplicated: true,
                    folderId: importFolderId
                  },
                  tx
                );
                nestedImportSecrets = nestedImportSecrets.concat(
                  newSecrets.map(({ id, version }) => ({ operation: SecretOperations.Delete, version, id }))
                );
              }
            });

            const folderLock = await keyStore
              .acquireLock([`secret-replication-${importFolderId}`], 5000)
              .catch(() => null);
            if (folderLock) {
              await snapshotService.performSnapshot(importFolderId);
              await folderLock.release();
            }

            await secretQueueService.syncSecrets({
              projectId,
              secretPath: importedFolder.path,
              _deDupeReplicationQueue: deDupeReplicationQueue,
              _deDupeQueue: deDupeQueue,
              environmentSlug: importedFolder.environmentSlug,
              actorId,
              actor,
              secrets: nestedImportSecrets,
              folderId: importedFolder.id,
              environmentId: importedFolder.envId
            });
          }

          // this is used to avoid multiple times generating secret approval by failed one
          await keyStore.setItemWithExpiry(
            keystoreReplicationSuccessKey(job.id as string, secretImport.id),
            SECRET_IMPORT_SUCCESS_LOCK,
            1,
            KeyStorePrefixes.SecretReplication
          );

          await secretImportDAL.updateById(secretImport.id, {
            lastReplicated: new Date(),
            replicationStatus: null,
            isReplicationSuccess: true
          });
        } catch (err) {
          logger.error(
            err,
            `Failed to replicate secret with import id=[${secretImport.id}] env=[${secretImport.importEnv.slug}] path=[${secretImport.importPath}]`
          );
          await secretImportDAL.updateById(secretImport.id, {
            lastReplicated: new Date(),
            replicationStatus: (err as Error)?.message.slice(0, 500),
            isReplicationSuccess: false
          });
        }
      }

      await secretVersionDAL.update({ $in: { id: replicatedSecrets.map(({ id }) => id) } }, { isReplicated: true });
      /*  eslint-enable no-await-in-loop */
    } finally {
      await lock.release();
      logger.info(job.data, "Replication finished");
    }
  });

  queueService.listen(QueueName.SecretReplication, "failed", (job, err) => {
    logger.error(err, "Failed to replicate secret", job?.data);
  });
};

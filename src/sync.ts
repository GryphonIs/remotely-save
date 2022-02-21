import { TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import type { RemoteItem, SUPPORTED_SERVICES_TYPE } from "./baseTypes";
import {
  decryptBase32ToString,
  decryptBase64urlToString,
  encryptStringToBase64url,
  MAGIC_ENCRYPTED_PREFIX_BASE32,
  MAGIC_ENCRYPTED_PREFIX_BASE64URL,
} from "./encrypt";
import type { FileFolderHistoryRecord, InternalDBs } from "./localdb";
import {
  clearDeleteRenameHistoryOfKeyAndVault,
  getSyncMetaMappingByRemoteKeyAndVault,
  upsertSyncMetaMappingDataByVault,
} from "./localdb";
import {
  isHiddenPath,
  isVaildText,
  mkdirpInVault,
  getFolderLevels,
  getParentFolder,
} from "./misc";
import { RemoteClient } from "./remote";
import {
  MetadataOnRemote,
  DeletionOnRemote,
  serializeMetadataOnRemote,
  deserializeMetadataOnRemote,
} from "./metadataOnRemote";

import * as origLog from "loglevel";
import { padEnd } from "lodash";
const log = origLog.getLogger("rs-default");

export type SyncStatusType =
  | "idle"
  | "preparing"
  | "getting_remote_meta"
  | "getting_local_meta"
  | "checking_password"
  | "generating_plan"
  | "syncing"
  | "finish";

type DecisionTypeForFile =
  | "skipUploading" // special, mtimeLocal === mtimeRemote
  | "uploadLocalDelHistToRemote" // "delLocalIfExists && delRemoteIfExists && cleanLocalDelHist && uploadLocalDelHistToRemote"
  | "keepRemoteDelHist" // "delLocalIfExists && delRemoteIfExists && cleanLocalDelHist && keepRemoteDelHist"
  | "uploadLocalToRemote" // "skipLocal && uploadLocalToRemote && cleanLocalDelHist && cleanRemoteDelHist"
  | "downloadRemoteToLocal"; // "downloadRemoteToLocal && skipRemote && cleanLocalDelHist && cleanRemoteDelHist"

type DecisionTypeForFolder =
  | "createLocalFolder"
  | "createRemoteFolder"
  | "delLocalFolder"
  | "delRemoteFolder"
  | "delLocalAndRemoteFolder"
  | "uploadLocalDelHistToRemoteFolder"
  | "keepRemoteDelHistFolder"
  | "skipFolder";

type DecisionType = DecisionTypeForFile | DecisionTypeForFolder;

interface FileOrFolderMixedState {
  key: string;
  existLocal?: boolean;
  existRemote?: boolean;
  mtimeLocal?: number;
  mtimeRemote?: number;
  deltimeLocal?: number;
  deltimeRemote?: number;
  sizeLocal?: number;
  sizeRemote?: number;
  changeMtimeUsingMapping?: boolean;
  decision?: DecisionType;
  syncDone?: "done";
  remoteEncryptedKey?: string;
}

export interface SyncPlanType {
  ts: number;
  remoteType: SUPPORTED_SERVICES_TYPE;
  mixedStates: Record<string, FileOrFolderMixedState>;
}

export interface PasswordCheckType {
  ok: boolean;
  reason:
    | "ok"
    | "empty_remote"
    | "remote_encrypted_local_no_password"
    | "password_matched"
    | "password_not_matched"
    | "invalid_text_after_decryption"
    | "remote_not_encrypted_local_has_password"
    | "no_password_both_sides";
}

export const isPasswordOk = async (
  remote: RemoteItem[],
  password: string = ""
) => {
  if (remote === undefined || remote.length === 0) {
    // remote empty
    return {
      ok: true,
      reason: "empty_remote",
    } as PasswordCheckType;
  }
  const santyCheckKey = remote[0].key;
  if (santyCheckKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE32)) {
    // this is encrypted using old base32!
    // try to decrypt it using the provided password.
    if (password === "") {
      return {
        ok: false,
        reason: "remote_encrypted_local_no_password",
      } as PasswordCheckType;
    }
    try {
      const res = await decryptBase32ToString(santyCheckKey, password);

      // additional test
      // because iOS Safari bypasses decryption with wrong password!
      if (isVaildText(res)) {
        return {
          ok: true,
          reason: "password_matched",
        } as PasswordCheckType;
      } else {
        return {
          ok: false,
          reason: "invalid_text_after_decryption",
        } as PasswordCheckType;
      }
    } catch (error) {
      return {
        ok: false,
        reason: "password_not_matched",
      } as PasswordCheckType;
    }
  }
  if (santyCheckKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)) {
    // this is encrypted using new base64url!
    // try to decrypt it using the provided password.
    if (password === "") {
      return {
        ok: false,
        reason: "remote_encrypted_local_no_password",
      } as PasswordCheckType;
    }
    try {
      const res = await decryptBase64urlToString(santyCheckKey, password);

      // additional test
      // because iOS Safari bypasses decryption with wrong password!
      if (isVaildText(res)) {
        return {
          ok: true,
          reason: "password_matched",
        } as PasswordCheckType;
      } else {
        return {
          ok: false,
          reason: "invalid_text_after_decryption",
        } as PasswordCheckType;
      }
    } catch (error) {
      return {
        ok: false,
        reason: "password_not_matched",
      } as PasswordCheckType;
    }
  } else {
    // it is not encrypted!
    if (password !== "") {
      return {
        ok: false,
        reason: "remote_not_encrypted_local_has_password",
      } as PasswordCheckType;
    }
    return {
      ok: true,
      reason: "no_password_both_sides",
    } as PasswordCheckType;
  }
};

const ensembleMixedStates = async (
  remote: RemoteItem[],
  local: TAbstractFile[],
  remoteDeleteHistory: DeletionOnRemote[],
  localDeleteHistory: FileFolderHistoryRecord[],
  db: InternalDBs,
  vaultRandomID: string,
  remoteType: SUPPORTED_SERVICES_TYPE,
  password: string = ""
) => {
  const results = {} as Record<string, FileOrFolderMixedState>;

  if (remote !== undefined) {
    for (const entry of remote) {
      const remoteEncryptedKey = entry.key;
      let key = remoteEncryptedKey;
      if (password !== "") {
        if (remoteEncryptedKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE32)) {
          key = await decryptBase32ToString(remoteEncryptedKey, password);
        } else if (
          remoteEncryptedKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)
        ) {
          key = await decryptBase64urlToString(remoteEncryptedKey, password);
        } else {
          throw Error(`unexpected key=${remoteEncryptedKey}`);
        }
      }
      const backwardMapping = await getSyncMetaMappingByRemoteKeyAndVault(
        remoteType,
        db,
        key,
        entry.lastModified,
        entry.etag,
        vaultRandomID
      );

      let r = {} as FileOrFolderMixedState;
      if (backwardMapping !== undefined) {
        key = backwardMapping.localKey;
        r = {
          key: key,
          existRemote: true,
          mtimeRemote: backwardMapping.localMtime || entry.lastModified,
          sizeRemote: backwardMapping.localSize || entry.size,
          remoteEncryptedKey: remoteEncryptedKey,
          changeMtimeUsingMapping: true,
        };
      } else {
        r = {
          key: key,
          existRemote: true,
          mtimeRemote: entry.lastModified,
          sizeRemote: entry.size,
          remoteEncryptedKey: remoteEncryptedKey,
          changeMtimeUsingMapping: false,
        };
      }
      if (isHiddenPath(key)) {
        continue;
      }
      if (results.hasOwnProperty(key)) {
        results[key].key = r.key;
        results[key].existRemote = r.existRemote;
        results[key].mtimeRemote = r.mtimeRemote;
        results[key].sizeRemote = r.sizeRemote;
        results[key].remoteEncryptedKey = r.remoteEncryptedKey;
        results[key].changeMtimeUsingMapping = r.changeMtimeUsingMapping;
      } else {
        results[key] = r;
      }
    }
  }

  for (const entry of local) {
    let r = {} as FileOrFolderMixedState;
    let key = entry.path;

    if (entry.path === "/") {
      // ignore
      continue;
    } else if (entry instanceof TFile) {
      r = {
        key: entry.path,
        existLocal: true,
        mtimeLocal: entry.stat.mtime,
        sizeLocal: entry.stat.size,
      };
    } else if (entry instanceof TFolder) {
      key = `${entry.path}/`;
      r = {
        key: key,
        existLocal: true,
        mtimeLocal: undefined,
        sizeLocal: 0,
      };
    } else {
      throw Error(`unexpected ${entry}`);
    }

    if (isHiddenPath(key)) {
      continue;
    }
    if (results.hasOwnProperty(key)) {
      results[key].key = r.key;
      results[key].existLocal = r.existLocal;
      results[key].mtimeLocal = r.mtimeLocal;
      results[key].sizeLocal = r.sizeLocal;
    } else {
      results[key] = r;
    }
  }

  for (const entry of remoteDeleteHistory) {
    const key = entry.key;
    const r = {
      key: key,
      deltimeRemote: entry.actionWhen,
    } as FileOrFolderMixedState;

    if (results.hasOwnProperty(key)) {
      results[key].key = r.key;
      results[key].deltimeRemote = r.deltimeRemote;
    } else {
      results[key] = r;
    }
  }

  for (const entry of localDeleteHistory) {
    let key = entry.key;
    if (entry.keyType === "folder") {
      if (!entry.key.endsWith("/")) {
        key = `${entry.key}/`;
      }
    } else if (entry.keyType === "file") {
      // pass
    } else {
      throw Error(`unexpected ${entry}`);
    }

    const r = {
      key: key,
      deltimeLocal: entry.actionWhen,
    } as FileOrFolderMixedState;

    if (isHiddenPath(key)) {
      continue;
    }
    if (results.hasOwnProperty(key)) {
      results[key].key = r.key;
      results[key].deltimeLocal = r.deltimeLocal;
    } else {
      results[key] = r;
    }
  }

  return results;
};

class FolderInfo {
  readonly m: Record<string, number>;
  constructor() {
    this.m = {};
  }
  getMustBeKeptChildrenCnt(x: string) {
    if (this.m[x] === undefined) {
      return 0;
    }
    return this.m[x];
  }
  addMustBeKeptChildrenCnt(x: string, n: number = 1) {
    if (this.m[x] === undefined) {
      this.m[x] = n;
    } else {
      this.m[x] += n;
    }
  }
  remove(x: string) {
    delete this.m[x];
  }
}

const assignOperationToFileInplace = (
  origRecord: FileOrFolderMixedState,
  folderInfo: FolderInfo
) => {
  let r = origRecord;

  // files and folders are treated differently
  // here we only check files
  if (r.key.endsWith("/")) {
    return r;
  }

  // we find the max date from four sources

  // 0. find anything inconsistent
  if (r.existLocal && (r.mtimeLocal === undefined || r.mtimeLocal <= 0)) {
    throw Error(
      `Error: File ${r.key} has a last modified time <=0 or undefined in the local file system. It's abnormal and the plugin stops.`
    );
  }
  if (r.existRemote && (r.mtimeRemote === undefined || r.mtimeRemote <= 0)) {
    throw Error(
      `Error: File ${r.key} has a last modified time <=0 or undefined on the remote service. It's abnormal and the plugin stops.`
    );
  }
  if (r.deltimeLocal !== undefined && r.deltimeLocal <= 0) {
    throw Error(
      `Error: File ${r.key} has a local deletion time <=0. It's abnormal and the plugin stops.`
    );
  }
  if (r.deltimeRemote !== undefined && r.deltimeRemote <= 0) {
    throw Error(
      `Error: File ${r.key} has a remote deletion time <=0. It's abnormal and the plugin stops.`
    );
  }

  // 1. mtimeLocal
  if (r.existLocal) {
    const mtimeRemote = r.existRemote ? r.mtimeRemote : -1;
    const deltime_remote = r.deltimeRemote !== undefined ? r.deltimeRemote : -1;
    const deltimeLocal = r.deltimeLocal !== undefined ? r.deltimeLocal : -1;
    if (
      r.mtimeLocal >= mtimeRemote &&
      r.mtimeLocal >= deltimeLocal &&
      r.mtimeLocal >= deltime_remote
    ) {
      if (r.mtimeLocal === r.mtimeRemote) {
        // mtime the same, do nothing
        r.decision = "skipUploading";
      } else {
        r.decision = "uploadLocalToRemote";
      }
      folderInfo.addMustBeKeptChildrenCnt(getParentFolder(r.key));
      return r;
    }
  }

  // 2. mtimeRemote
  if (r.existRemote) {
    const mtimeLocal = r.existLocal ? r.mtimeLocal : -1;
    const deltime_remote = r.deltimeRemote !== undefined ? r.deltimeRemote : -1;
    const deltimeLocal = r.deltimeLocal !== undefined ? r.deltimeLocal : -1;
    if (
      r.mtimeRemote > mtimeLocal &&
      r.mtimeRemote >= deltimeLocal &&
      r.mtimeRemote >= deltime_remote
    ) {
      r.decision = "downloadRemoteToLocal";
      folderInfo.addMustBeKeptChildrenCnt(getParentFolder(r.key));
      return r;
    }
  }

  // 3. deltimeLocal
  if (r.deltimeLocal !== undefined && r.deltimeLocal !== 0) {
    const mtimeLocal = r.existLocal ? r.mtimeLocal : -1;
    const mtimeRemote = r.existRemote ? r.mtimeRemote : -1;
    const deltime_remote = r.deltimeRemote !== undefined ? r.deltimeRemote : -1;
    if (
      r.deltimeLocal >= mtimeLocal &&
      r.deltimeLocal >= mtimeRemote &&
      r.deltimeLocal >= deltime_remote
    ) {
      r.decision = "uploadLocalDelHistToRemote";
      if (r.existLocal || r.existRemote) {
        // actual deletion would happen
      }
      return r;
    }
  }

  // 4. deltime_remote
  if (r.deltimeRemote !== undefined && r.deltimeRemote !== 0) {
    const mtimeLocal = r.existLocal ? r.mtimeLocal : -1;
    const mtimeRemote = r.existRemote ? r.mtimeRemote : -1;
    const deltimeLocal = r.deltimeLocal !== undefined ? r.deltimeLocal : -1;
    if (
      r.deltimeRemote >= mtimeLocal &&
      r.deltimeRemote >= mtimeRemote &&
      r.deltimeRemote >= deltimeLocal
    ) {
      r.decision = "keepRemoteDelHist";
      if (r.existLocal || r.existRemote) {
        // actual deletion would happen
      }
      return r;
    }
  }

  throw Error(`no decision for ${JSON.stringify(r)}`);
};

const assignOperationToFolderInplace = (
  origRecord: FileOrFolderMixedState,
  folderInfo: FolderInfo
) => {
  let r = origRecord;

  // files and folders are treated differently
  // here we only check folders
  if (!r.key.endsWith("/")) {
    return r;
  }

  if (folderInfo.getMustBeKeptChildrenCnt(r.key) === 0) {
    // the folder does NOT have any must-be-kept children!

    if (r.deltimeLocal !== undefined || r.deltimeRemote !== undefined) {
      // it has some deletion "commands"
      if (r.existLocal && r.existRemote) {
        r.decision = "delLocalAndRemoteFolder";
      } else if (r.existLocal && !r.existRemote) {
        r.decision = "delLocalFolder";
      } else if (!r.existLocal && r.existRemote) {
        r.decision = "delRemoteFolder";
      } else {
        // no exists
        // actually deleted before???
        if (
          r.deltimeLocal !== undefined &&
          r.deltimeLocal >=
            (r.deltimeRemote !== undefined ? r.deltimeRemote : -1)
        ) {
          r.decision = "uploadLocalDelHistToRemoteFolder";
        } else {
          r.decision = "keepRemoteDelHistFolder";
        }
      }
    } else {
      // it does not have any deletion commands
      // keep it as is, and skip it!
      r.decision = "skipFolder";
      if (r.existLocal || r.existRemote) {
        folderInfo.addMustBeKeptChildrenCnt(getParentFolder(r.key));
      }
      folderInfo.remove(r.key);
      return r;
    }
  } else {
    // the folder has some must be kept children!

    if (!r.existRemote && !r.existLocal) {
      throw Error(
        `Error: Folder ${r.key} doesn't exist locally and remotely but is marked must be kept. Abort.`
      );
    }
    if (!r.existLocal) {
      r.decision = "createLocalFolder";
      folderInfo.remove(r.key);
      folderInfo.addMustBeKeptChildrenCnt(getParentFolder(r.key));
      return r;
    }
    if (!r.existRemote) {
      r.decision = "createRemoteFolder";
      folderInfo.remove(r.key);
      folderInfo.addMustBeKeptChildrenCnt(getParentFolder(r.key));
      return r;
    }
    if (r.existLocal && r.existRemote) {
      r.decision = "skipFolder";
      folderInfo.remove(r.key);
      folderInfo.addMustBeKeptChildrenCnt(getParentFolder(r.key));
      return r;
    }
  }
};

export const getSyncPlan = async (
  remote: RemoteItem[],
  local: TAbstractFile[],
  remoteDeleteHistory: DeletionOnRemote[],
  localDeleteHistory: FileFolderHistoryRecord[],
  db: InternalDBs,
  vaultRandomID: string,
  remoteType: SUPPORTED_SERVICES_TYPE,
  password: string = ""
) => {
  const mixedStates = await ensembleMixedStates(
    remote,
    local,
    remoteDeleteHistory,
    localDeleteHistory,
    db,
    vaultRandomID,
    remoteType,
    password
  );

  const sortedKeys = Object.keys(mixedStates).sort(
    (k1, k2) => k2.length - k1.length
  );
  const totalCount = sortedKeys.length || 0;

  const folderInfo = new FolderInfo();
  for (let i = 0; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i];
    const val = mixedStates[key];
    let prevKey: string = undefined;
    if (i > 0) {
      prevKey = sortedKeys[i - 1];
    }

    if (key.endsWith("/")) {
      // decide some folders
      // because the keys are sorted by length
      // so all the children must have been shown up before in the iteration
      assignOperationToFolderInplace(val, folderInfo);
    } else {
      // get all operations of files
      // and at the same time get some helper info for folders
      assignOperationToFileInplace(val, folderInfo);
    }
  }

  const plan = {
    ts: Date.now(),
    remoteType: remoteType,
    mixedStates: mixedStates,
  } as SyncPlanType;
  return plan;
};

export const doActualSync = async (
  client: RemoteClient,
  db: InternalDBs,
  vaultRandomID: string,
  vault: Vault,
  syncPlan: SyncPlanType,
  password: string = "",
  callbackSyncProcess?: any
) => {};

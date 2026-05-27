import joplin from 'api';
import { MenuItemLocation, SettingItemType } from 'api/types';
import * as fs from 'fs';
import * as path from 'path';

const PLUGIN_NAME = 'Auto Icon Assigner';
const SETTINGS_SECTION = 'autoIconAssigner.settings';
const SETTING_AUTO_ASSIGN = 'autoIconAssigner.autoAssignNewFolders';
const SETTING_POLL_INTERVAL = 'autoIconAssigner.pollIntervalSeconds';
const SETTING_EVENT_CURSOR = 'autoIconAssigner.lastEventCursor';
const SETTING_OPEN_STORED_ICONS = 'autoIconAssigner.openStoredIconsViewer';
const SETTING_MATRIX_SUMMARY = 'autoIconAssigner.matrixSummary';
const SETTING_PICK_ICON_PREFIX = 'autoIconAssigner.pickIcon.';
const SETTING_ROOT_AUTO_PREFIX = 'autoIconAssigner.rootAuto.';
const ROOT_CONFIG_USER_DATA_KEY = 'com.arena.joplin-auto-icon-assigner.rootConfig.v1';

const ITEM_TYPE_FOLDER = 2;
const EVENT_TYPE_CREATED = 1;
const FOLDER_ICON_TYPE_DATA_URL = 2;

type LevelKey = '1' | '2' | '3' | '4';
const LEVEL_KEYS: LevelKey[] = ['1', '2', '3', '4'];
let dialogIdCounter = 0;
function nextDialogId(prefix: string): string {
  dialogIdCounter += 1;
  return `${prefix}_${Date.now()}_${dialogIdCounter}`;
}

interface FolderEntity {
  id: string;
  title: string;
  parent_id?: string;
  icon?: string;
}

interface RootIconConfig {
  version: 1;
  rootId: string;
  rootTitle: string;
  icons: Partial<Record<LevelKey, string>>;
  sourceFileNames: Partial<Record<LevelKey, string>>;
  autoAssignOnCreation: boolean;
  updatedAt: string;
}

interface ApplyDetail {
  folderId: string;
  title: string;
  level: LevelKey;
  action: 'changed' | 'would-change' | 'skipped-existing' | 'skipped-no-config' | 'error';
  message?: string;
}

interface ApplyStats {
  scanned: number;
  changed: number;
  skippedExisting: number;
  skippedNoConfiguredIcon: number;
  errors: number;
  details: ApplyDetail[];
}

interface IconBackupFolder {
  id: string;
  title: string;
  parent_id: string;
  path: string;
  icon: string;
}

interface IconBackupDocument {
  schema: 'joplin-auto-icon-assigner.icon-backup';
  version: 1;
  createdAt: string;
  reason: string;
  folders: IconBackupFolder[];
}

function levelLabel(level: LevelKey): string {
  if (level === '1') return 'Level 1 / top-level notebook';
  if (level === '2') return 'Level 2 / direct children';
  if (level === '3') return 'Level 3 / grandchildren';
  return 'Level 4 and below';
}

function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function folderHasIcon(folder: FolderEntity): boolean {
  return !!(folder.icon && String(folder.icon).trim());
}

function iconDataUrlToFolderIconString(dataUrl: string): string {
  return JSON.stringify({
    type: FOLDER_ICON_TYPE_DATA_URL,
    emoji: '',
    name: '',
    dataUrl,
  });
}


function folderIconStringToDataUrl(iconString: string | undefined): string {
  if (!iconString) return '';
  try {
    const parsed = JSON.parse(iconString);
    return parsed?.dataUrl || '';
  } catch (_) {
    return '';
  }
}

function shortIconDescription(iconString: string | undefined): string {
  const dataUrl = folderIconStringToDataUrl(iconString);
  if (!dataUrl) return iconString ? 'stored icon' : 'not set';
  const mimeMatch = dataUrl.match(/^data:([^;]+);/);
  const kb = Math.round(dataUrl.length * 0.75 / 1024);
  return `${mimeMatch?.[1] || 'image'}; approx. ${kb} KB`;
}

function extensionToMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function fileToFolderIconString(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  const dataUrl = `data:${extensionToMime(filePath)};base64,${buffer.toString('base64')}`;
  return iconDataUrlToFolderIconString(dataUrl);
}

async function getAllPaged(resource: string, query: Record<string, unknown> = {}): Promise<any[]> {
  let page = 1;
  const items: any[] = [];
  while (true) {
    const result = await joplin.data.get([resource], { ...query, page, limit: 100 });
    if (Array.isArray(result)) return result;
    if (result?.items) items.push(...result.items);
    if (!result?.has_more) break;
    page += 1;
  }
  return items;
}

async function getAllFolders(): Promise<FolderEntity[]> {
  return await getAllPaged('folders', { fields: ['id', 'title', 'parent_id', 'icon'] });
}

async function getFolder(folderId: string): Promise<FolderEntity> {
  return await joplin.data.get(['folders', folderId], { fields: ['id', 'title', 'parent_id', 'icon'] });
}

function mapFolders(folders: FolderEntity[]): Map<string, FolderEntity> {
  return new Map(folders.map(folder => [folder.id, folder]));
}

function childrenByParent(folders: FolderEntity[]): Map<string, FolderEntity[]> {
  const map = new Map<string, FolderEntity[]>();
  for (const folder of folders) {
    const parentId = folder.parent_id || '';
    if (!map.has(parentId)) map.set(parentId, []);
    map.get(parentId)!.push(folder);
  }
  return map;
}

function findRootFolder(folder: FolderEntity, folderMap: Map<string, FolderEntity>): FolderEntity {
  let current = folder;
  const visited = new Set<string>();
  while (current.parent_id && folderMap.has(current.parent_id) && !visited.has(current.id)) {
    visited.add(current.id);
    current = folderMap.get(current.parent_id)!;
  }
  return current;
}

function subtreeWithDepth(root: FolderEntity, folders: FolderEntity[]): Array<{ folder: FolderEntity; depth: number }> {
  const byParent = childrenByParent(folders);
  const output: Array<{ folder: FolderEntity; depth: number }> = [];
  const queue: Array<{ folder: FolderEntity; depth: number }> = [{ folder: root, depth: 1 }];

  while (queue.length) {
    const item = queue.shift()!;
    output.push(item);
    const children = byParent.get(item.folder.id) || [];
    for (const child of children) queue.push({ folder: child, depth: item.depth + 1 });
  }

  return output;
}

function depthToLevelKey(depth: number): LevelKey {
  if (depth <= 1) return '1';
  if (depth === 2) return '2';
  if (depth === 3) return '3';
  return '4';
}

async function loadRootConfig(rootId: string): Promise<RootIconConfig | null> {
  try {
    const value = await joplin.data.userDataGet(ITEM_TYPE_FOLDER, rootId, ROOT_CONFIG_USER_DATA_KEY) as RootIconConfig | null;
    if (!value || value.version !== 1) return null;
    return value;
  } catch (error) {
    console.warn(`${PLUGIN_NAME}: Failed to load root config for ${rootId}`, error);
    return null;
  }
}

async function saveRootConfig(config: RootIconConfig): Promise<void> {
  await joplin.data.userDataSet(ITEM_TYPE_FOLDER, config.rootId, ROOT_CONFIG_USER_DATA_KEY, config);
}

async function showConfigureOptionsDialog(root: FolderEntity, existingConfig: RootIconConfig | null): Promise<null | {
  overwriteExisting: boolean;
  applyNow: boolean;
  autoAssignOnCreation: boolean;
  pickLevels: Record<LevelKey, boolean>;
}> {
  const handle = await joplin.views.dialogs.create(nextDialogId('autoIconAssignerConfigureDialog'));
  await joplin.views.dialogs.setFitToContent(handle, true);
  await joplin.views.dialogs.setButtons(handle, [
    { id: 'submit', title: 'Continue' },
    { id: 'cancel', title: 'Cancel' },
  ]);

  const rows = LEVEL_KEYS.map(level => {
    const hasIcon = !!existingConfig?.icons?.[level];
    const fileName = existingConfig?.sourceFileNames?.[level] || (hasIcon ? '(stored icon)' : 'not set');
    const checked = hasIcon ? '' : 'checked';
    return `
      <label class="row">
        <span><strong>${htmlEscape(levelLabel(level))}</strong><br><small>Current: ${htmlEscape(fileName)}</small></span>
        <input type="checkbox" name="pick${level}" value="1" ${checked} />
      </label>`;
  }).join('');

  await joplin.views.dialogs.setHtml(handle, `
    <style>
      body { font-family: sans-serif; padding: 8px 12px; color: #222; }
      .muted { color: #666; }
      .box { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 12px 0; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid #eee; }
      .row:last-child { border-bottom: none; }
      input[type="checkbox"] { transform: scale(1.15); }
    </style>
    <h2>${PLUGIN_NAME}</h2>
    <p>Configure icons for top-level notebook <strong>${htmlEscape(root.title)}</strong>.</p>
    <p class="muted">Tick the levels for which you want to choose a new PNG/JPG icon. Unticked levels keep their stored icon.</p>
    <form name="options">
      <div class="box">
        ${rows}
      </div>
      <label class="row">
        <span><strong>Apply to notebooks immediately</strong><br><small>If off, the selected icons are only stored for this top-level notebook. This is the safest first test.</small></span>
        <input type="checkbox" name="applyNow" value="1" />
      </label>
      <label class="row">
        <span><strong>Overwrite existing notebook icons while applying now</strong><br><small>If off, folders that already have any icon are skipped.</small></span>
        <input type="checkbox" name="overwriteExisting" value="1" />
      </label>
      <label class="row">
        <span><strong>Auto-assign this notebook's stored level icons to newly created folders</strong><br><small>Requires the global plugin setting to be enabled.</small></span>
        <input type="checkbox" name="autoAssignOnCreation" value="1" ${existingConfig?.autoAssignOnCreation ? 'checked' : ''} />
      </label>
    </form>
  `);

  const result = await joplin.views.dialogs.open(handle);
  if (result.id !== 'submit') return null;

  const form = result.formData?.options || {};
  return {
    overwriteExisting: form.overwriteExisting === '1' || form.overwriteExisting === 'on' || form.overwriteExisting === true,
    applyNow: form.applyNow === '1' || form.applyNow === 'on' || form.applyNow === true,
    autoAssignOnCreation: form.autoAssignOnCreation === '1' || form.autoAssignOnCreation === 'on' || form.autoAssignOnCreation === true,
    pickLevels: {
      '1': form.pick1 === '1' || form.pick1 === 'on' || form.pick1 === true,
      '2': form.pick2 === '1' || form.pick2 === 'on' || form.pick2 === true,
      '3': form.pick3 === '1' || form.pick3 === 'on' || form.pick3 === true,
      '4': form.pick4 === '1' || form.pick4 === 'on' || form.pick4 === true,
    },
  };
}

async function pickIconForLevel(level: LevelKey): Promise<string | null> {
  const result: string[] | null = await joplin.views.dialogs.showOpenDialog({
    title: `Select icon for ${levelLabel(level)}`,
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg'] },
      { name: 'PNG', extensions: ['png'] },
      { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
    ],
  });
  if (!result || !result.length) return null;
  return result[0];
}

async function applyConfigToRoot(root: FolderEntity, config: RootIconConfig, overwriteExisting: boolean, dryRun = false): Promise<ApplyStats> {
  const stats: ApplyStats = { scanned: 0, changed: 0, skippedExisting: 0, skippedNoConfiguredIcon: 0, errors: 0, details: [] };
  const folders = await getAllFolders();
  const subtree = subtreeWithDepth(root, folders);

  for (const { folder, depth } of subtree) {
    stats.scanned += 1;
    const level = depthToLevelKey(depth);
    const icon = config.icons[level];
    if (!icon) {
      stats.skippedNoConfiguredIcon += 1;
      stats.details.push({ folderId: folder.id, title: folder.title, level, action: 'skipped-no-config', message: 'No icon configured for this level' });
      continue;
    }
    if (!overwriteExisting && folderHasIcon(folder)) {
      stats.skippedExisting += 1;
      stats.details.push({ folderId: folder.id, title: folder.title, level, action: 'skipped-existing', message: 'Folder already has an icon' });
      continue;
    }
    try {
      if (!dryRun) await joplin.data.put(['folders', folder.id], null, { icon });
      stats.changed += 1;
      stats.details.push({ folderId: folder.id, title: folder.title, level, action: dryRun ? 'would-change' : 'changed' });
    } catch (error) {
      stats.errors += 1;
      stats.details.push({ folderId: folder.id, title: folder.title, level, action: 'error', message: String(error) });
      console.error(`${PLUGIN_NAME}: Failed to set icon for folder ${folder.id}`, error);
    }
  }

  return stats;
}

async function showStats(prefix: string, stats: ApplyStats): Promise<void> {
  const detailRows = stats.details.map(detail => `
    <tr class="${htmlEscape(detail.action)}">
      <td>${htmlEscape(detail.action)}</td>
      <td>${htmlEscape(levelLabel(detail.level))}</td>
      <td>${htmlEscape(detail.title)}</td>
      <td><code>${htmlEscape(detail.folderId)}</code></td>
      <td>${htmlEscape(detail.message || '')}</td>
    </tr>`).join('');

  const handle = await joplin.views.dialogs.create(nextDialogId('autoIconAssignerStats'));
  await joplin.views.dialogs.setFitToContent(handle, false);
  await joplin.views.dialogs.setButtons(handle, [{ id: 'ok', title: 'Close' }]);
  await joplin.views.dialogs.setHtml(handle, `
    <style>
      :root { color-scheme: light dark; }
      body { font-family: sans-serif; margin: 0; padding: 16px; color: var(--joplin-color, CanvasText); background: var(--joplin-background-color, Canvas); overflow: auto; }
      .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 12px 0; }
      .card { border: 1px solid var(--joplin-divider-color, GrayText); border-radius: 8px; padding: 8px; }
      .num { font-size: 20px; font-weight: bold; }
      details { margin-top: 12px; }
      .table-wrap { max-height: 55vh; overflow: auto; border: 1px solid var(--joplin-divider-color, GrayText); border-radius: 8px; }
      table { border-collapse: collapse; width: 100%; min-width: 760px; }
      th, td { padding: 6px 8px; border-bottom: 1px solid var(--joplin-divider-color, GrayText); text-align: left; }
      th { position: sticky; top: 0; background: var(--joplin-background-color, Canvas); }
      .error td { color: #ff6b6b; }
      .changed td, .would-change td { color: #69db7c; }
      .skipped-existing td, .skipped-no-config td { opacity: .85; }
    </style>
    <h2>${htmlEscape(prefix)}</h2>
    <div class="summary">
      <div class="card"><div class="num">${stats.scanned}</div><div>Scanned</div></div>
      <div class="card"><div class="num">${stats.changed}</div><div>Would change / changed</div></div>
      <div class="card"><div class="num">${stats.skippedExisting}</div><div>Skipped existing</div></div>
      <div class="card"><div class="num">${stats.skippedNoConfiguredIcon}</div><div>Skipped no config</div></div>
      <div class="card"><div class="num">${stats.errors}</div><div>Errors</div></div>
    </div>
    <details>
      <summary>Details (${stats.details.length})</summary>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Action</th><th>Level</th><th>Notebook/folder</th><th>ID</th><th>Message</th></tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
      </div>
    </details>
  `);
  await joplin.views.dialogs.open(handle);
}

async function showStoredIconsViewer(): Promise<void> {
  await showMatrixManager(undefined, true);
}


async function configureAndApply(folderId: string): Promise<void> {
  await showMatrixManager(folderId, false);
}



function folderPath(folder: FolderEntity, folderMap: Map<string, FolderEntity>): string {
  const parts: string[] = [folder.title];
  let current = folder;
  const visited = new Set<string>();
  while (current.parent_id && folderMap.has(current.parent_id) && !visited.has(current.id)) {
    visited.add(current.id);
    current = folderMap.get(current.parent_id)!;
    parts.unshift(current.title);
  }
  return parts.join(' / ');
}

function buildIconBackupDocument(targetRoots: FolderEntity[], allFolders: FolderEntity[], reason: string): IconBackupDocument {
  const folderMap = mapFolders(allFolders);
  const allowedIds = new Set<string>();
  for (const root of targetRoots) {
    for (const item of subtreeWithDepth(root, allFolders)) allowedIds.add(item.folder.id);
  }

  return {
    schema: 'joplin-auto-icon-assigner.icon-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    reason,
    folders: allFolders
      .filter(folder => allowedIds.has(folder.id))
      .map(folder => ({
        id: folder.id,
        title: folder.title,
        parent_id: folder.parent_id || '',
        path: folderPath(folder, folderMap),
        icon: folder.icon || '',
      })),
  };
}

function backupMarkdown(backup: IconBackupDocument, reportMarkdown = ''): string {
  return `# Auto Icon Assigner icon backup\n\nCreated: ${backup.createdAt}\n\nReason: ${backup.reason}\n\nFolders included: ${backup.folders.length}\n\n${reportMarkdown}\n\n## Restore JSON\n\nCopy the JSON below and use \"Restore icons from backup JSON\".\n\n\`\`\`json\n${JSON.stringify(backup, null, 2)}\n\`\`\`\n`;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (joplin.clipboard?.writeText) {
      await joplin.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn(`${PLUGIN_NAME}: Could not copy backup JSON to clipboard`, error);
  }
  return false;
}

async function createIconBackupNote(targetRoots: FolderEntity[], reason: string): Promise<{ noteId: string; body: string; backup: IconBackupDocument; copied: boolean }> {
  const allFolders = await getAllFolders();
  const backup = buildIconBackupDocument(targetRoots, allFolders, reason);
  const rootTitle = targetRoots.length === 1 ? targetRoots[0].title : `${targetRoots.length} top-level notebooks`;
  const title = `Auto Icon Assigner backup - ${rootTitle} - ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const body = backupMarkdown(backup);
  const note = await joplin.data.post(['notes'], null, {
    parent_id: targetRoots[0].id,
    title,
    body,
  });
  const copied = await copyTextToClipboard(JSON.stringify(backup, null, 2));
  console.info(`${PLUGIN_NAME}: Created backup note ${note.id} with ${backup.folders.length} folders. Clipboard copied: ${copied}`);
  return { noteId: note.id, body, backup, copied };
}

function statsMarkdownByRoot(statsByRoot: Array<{ root: FolderEntity; stats: ApplyStats }>): string {
  const lines: string[] = ['## Apply report', ''];
  for (const entry of statsByRoot) {
    const s = entry.stats;
    lines.push(`### ${entry.root.title}`);
    lines.push(`- Scanned: ${s.scanned}`);
    lines.push(`- Changed: ${s.changed}`);
    lines.push(`- Skipped existing icons: ${s.skippedExisting}`);
    lines.push(`- Skipped no configured icon: ${s.skippedNoConfiguredIcon}`);
    lines.push(`- Errors: ${s.errors}`);
    lines.push('');
    lines.push('<details><summary>Details</summary>');
    lines.push('');
    lines.push('| Action | Level | Notebook/folder | ID | Message |');
    lines.push('|---|---|---|---|---|');
    for (const d of s.details) {
      lines.push(`| ${d.action} | ${levelLabel(d.level)} | ${String(d.title).replace(/\|/g, '\\|')} | ${d.folderId} | ${String(d.message || '').replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  return lines.join('\n');
}

async function appendReportToBackupNote(noteId: string, originalBody: string, statsByRoot: Array<{ root: FolderEntity; stats: ApplyStats }>): Promise<void> {
  try {
    await joplin.data.put(['notes', noteId], null, { body: backupMarkdown((extractBackupFromText(originalBody) as IconBackupDocument), statsMarkdownByRoot(statsByRoot)) });
  } catch (error) {
    // Fallback: append plain report to existing body
    try {
      await joplin.data.put(['notes', noteId], null, { body: `${originalBody}\n\n${statsMarkdownByRoot(statsByRoot)}` });
    } catch (innerError) {
      console.warn(`${PLUGIN_NAME}: Could not append apply report to backup note`, innerError || error);
    }
  }
}

function extractBackupFromText(text: string): IconBackupDocument | null {
  const trimmed = String(text || '').trim();
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```\s*([\s\S]*?)```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : trimmed;
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed?.schema === 'joplin-auto-icon-assigner.icon-backup' && parsed.version === 1 && Array.isArray(parsed.folders)) return parsed;
  } catch (_) {}
  return null;
}

async function restoreIconsFromBackupJsonDialog(): Promise<void> {
  const handle = await joplin.views.dialogs.create(nextDialogId('autoIconAssignerRestoreBackup'));
  await joplin.views.dialogs.setFitToContent(handle, false);
  await joplin.views.dialogs.setButtons(handle, [
    { id: 'submit', title: 'Restore icons' },
    { id: 'cancel', title: 'Cancel' },
  ]);
  await joplin.views.dialogs.setHtml(handle, `
    <style>
      :root { color-scheme: light dark; }
      body { font-family: sans-serif; color: var(--joplin-color, CanvasText); background: var(--joplin-background-color, Canvas); padding: 16px; }
      textarea { width: 100%; height: 55vh; box-sizing: border-box; font-family: monospace; color: CanvasText; background: Canvas; }
      .warn { border: 1px solid #f59f00; padding: 10px; border-radius: 8px; }
    </style>
    <h2>Restore notebook icons from backup JSON</h2>
    <p class="warn">This restores the <code>folders.icon</code> field for every folder in the backup JSON. A new backup of current icons will be created before restoring.</p>
    <form name="restore"><textarea name="json" placeholder="Paste Auto Icon Assigner backup JSON here, or a full backup note containing a json code block"></textarea></form>
  `);
  const result = await joplin.views.dialogs.open(handle);
  if (result.id !== 'submit') return;
  const text = result.formData?.restore?.json || '';
  const backup = extractBackupFromText(text);
  if (!backup) {
    await joplin.views.dialogs.showMessageBox('Could not parse a valid Auto Icon Assigner backup JSON document.');
    return;
  }
  const confirm = await joplin.views.dialogs.showMessageBox(`Restore icons for ${backup.folders.length} folders from backup created ${backup.createdAt}?\n\nA backup of current icons will be created before restoring.`);
  if (confirm !== 0) return;

  const allFolders = await getAllFolders();
  const folderMap = mapFolders(allFolders);
  const rootMap = new Map<string, FolderEntity>();
  for (const item of backup.folders) {
    const current = folderMap.get(item.id);
    if (!current) continue;
    const root = findRootFolder(current, folderMap);
    rootMap.set(root.id, root);
  }
  const roots = Array.from(rootMap.values());
  if (roots.length) await createIconBackupNote(roots, 'automatic backup before restoring icon backup JSON');

  let changed = 0;
  let missing = 0;
  let errors = 0;
  for (const item of backup.folders) {
    if (!folderMap.has(item.id)) {
      missing += 1;
      continue;
    }
    try {
      await joplin.data.put(['folders', item.id], null, { icon: item.icon || '' });
      changed += 1;
    } catch (error) {
      errors += 1;
      console.error(`${PLUGIN_NAME}: Could not restore icon for ${item.id}`, error);
    }
  }
  await joplin.views.dialogs.showMessageBox(`Restore complete.\n\nRestored: ${changed}\nMissing folders: ${missing}\nErrors: ${errors}`);
}

async function backupSelectedRoot(folderId?: string): Promise<void> {
  const id = folderId || await selectedFolderIdOrMessage();
  if (!id) return;
  const folders = await getAllFolders();
  const folderMap = mapFolders(folders);
  const selected = folderMap.get(id) || await getFolder(id);
  const root = findRootFolder(selected, folderMap);
  const result = await createIconBackupNote([root], 'manual backup');
  await joplin.views.dialogs.showMessageBox(`Backup note created in "${root.title}".\n\nFolders backed up: ${result.backup.folders.length}\nJSON copied to clipboard: ${result.copied ? 'yes' : 'no'}`);
}

async function backupAllRoots(): Promise<void> {
  const folders = await getAllFolders();
  const roots = folders.filter(folder => !folder.parent_id);
  if (!roots.length) return;
  const result = await createIconBackupNote(roots, 'manual backup of all top-level notebooks');
  await joplin.views.dialogs.showMessageBox(`Backup note created in "${roots[0].title}".\n\nFolders backed up: ${result.backup.folders.length}\nJSON copied to clipboard: ${result.copied ? 'yes' : 'no'}`);
}

async function applyStoredConfig(folderId: string, overwriteExisting = false): Promise<void> {
  const folders = await getAllFolders();
  const folderMap = mapFolders(folders);
  const selected = folderMap.get(folderId) || await getFolder(folderId);
  const root = findRootFolder(selected, folderMap);
  const config = await loadRootConfig(root.id);
  if (!config) {
    await joplin.views.dialogs.showMessageBox(`No stored icon configuration found for top-level notebook "${root.title}".`);
    return;
  }
  if (overwriteExisting) {
    const confirm = await joplin.views.dialogs.showMessageBox(`Overwrite existing icons under "${root.title}"?

A backup note will be created before applying. Cancel to abort.`);
    if (confirm !== 0) return;
  }
  const backup = await createIconBackupNote([root], `automatic backup before applying stored icons (${overwriteExisting ? 'overwrite existing' : 'skip existing'})`);
  const stats = await applyConfigToRoot(root, config, overwriteExisting);
  await appendReportToBackupNote(backup.noteId, backup.body, [{ root, stats }]);
  console.info(`${PLUGIN_NAME}: Finished applying stored icons to ${root.title}`, stats);
}

async function previewStoredConfig(folderId: string, overwriteExisting = false): Promise<void> {
  const folders = await getAllFolders();
  const folderMap = mapFolders(folders);
  const selected = folderMap.get(folderId) || await getFolder(folderId);
  const root = findRootFolder(selected, folderMap);
  const config = await loadRootConfig(root.id);
  if (!config) {
    await joplin.views.dialogs.showMessageBox(`No stored icon configuration found for top-level notebook "${root.title}".`);
    return;
  }
  const stats = await applyConfigToRoot(root, config, overwriteExisting, true);
  await showStats(`Preview only for ${root.title}. No notebook icons were changed.`, stats);
}


function emptyRootConfig(root: FolderEntity): RootIconConfig {
  return {
    version: 1,
    rootId: root.id,
    rootTitle: root.title,
    icons: {},
    sourceFileNames: {},
    autoAssignOnCreation: false,
    updatedAt: new Date().toISOString(),
  };
}

function rootSelectOptions(roots: FolderEntity[], selectedRootId: string): string {
  return roots.map(root => `<option value="${htmlEscape(root.id)}" ${root.id === selectedRootId ? 'selected' : ''}>${htmlEscape(root.title)}</option>`).join('');
}

async function loadConfigsForRoots(roots: FolderEntity[]): Promise<Map<string, RootIconConfig>> {
  const configs = new Map<string, RootIconConfig>();
  for (const root of roots) {
    configs.set(root.id, await loadRootConfig(root.id) || emptyRootConfig(root));
  }
  return configs;
}

function iconPreviewHtml(icon: string | undefined): string {
  const dataUrl = folderIconStringToDataUrl(icon);
  if (!dataUrl) return '<span class="no-icon">+</span>';
  return `<img src="${htmlEscape(dataUrl)}" alt="icon preview" />`;
}

async function saveAutoAssignFlagsFromForm(roots: FolderEntity[], configs: Map<string, RootIconConfig>, form: any): Promise<void> {
  for (const root of roots) {
    const config = configs.get(root.id) || emptyRootConfig(root);
    config.rootTitle = root.title;
    config.autoAssignOnCreation = form[`auto_${root.id}`] === '1' || form[`auto_${root.id}`] === 'on' || form[`auto_${root.id}`] === true;
    config.updatedAt = new Date().toISOString();
    // Only save configs that already contain an icon or have auto-assign enabled.
    if (config.autoAssignOnCreation || LEVEL_KEYS.some(level => !!config.icons[level])) {
      await saveRootConfig(config);
    }
  }
}


function parsePickIconSettingKey(key: string): null | { rootId: string; level: LevelKey } {
  if (!key.startsWith(SETTING_PICK_ICON_PREFIX)) return null;
  const rest = key.substring(SETTING_PICK_ICON_PREFIX.length);
  const parts = rest.split('.');
  const levelRaw = parts.pop() || '';
  const rootId = parts.join('.');
  if (!rootId || !LEVEL_KEYS.includes(levelRaw as LevelKey)) return null;
  return { rootId, level: levelRaw as LevelKey };
}

function parseRootAutoSettingKey(key: string): null | { rootId: string } {
  if (!key.startsWith(SETTING_ROOT_AUTO_PREFIX)) return null;
  const rootId = key.substring(SETTING_ROOT_AUTO_PREFIX.length);
  return rootId ? { rootId } : null;
}

async function pickAndStoreIconForRootLevel(rootId: string, level: LevelKey): Promise<void> {
  const root = await getFolder(rootId);
  const filePath = await pickIconForLevel(level);
  if (!filePath) return;
  const config = await loadRootConfig(root.id) || emptyRootConfig(root);
  config.rootTitle = root.title;
  config.icons[level] = fileToFolderIconString(filePath);
  config.sourceFileNames[level] = path.basename(filePath);
  config.updatedAt = new Date().toISOString();
  await saveRootConfig(config);
  console.info(`${PLUGIN_NAME}: Stored icon for ${root.title} ${levelLabel(level)} from ${filePath}`);
}

async function updateRootAutoAssign(rootId: string, enabled: boolean): Promise<void> {
  const root = await getFolder(rootId);
  const config = await loadRootConfig(root.id) || emptyRootConfig(root);
  config.rootTitle = root.title;
  config.autoAssignOnCreation = enabled;
  config.updatedAt = new Date().toISOString();
  await saveRootConfig(config);
  console.info(`${PLUGIN_NAME}: Auto-assign for ${root.title}: ${enabled ? 'enabled' : 'disabled'}`);
}

async function showMatrixManager(initialFolderId?: string, readonly = false): Promise<void> {
  const allFolders = await getAllFolders();
  const folderMap = mapFolders(allFolders);
  const roots = allFolders.filter(folder => !folder.parent_id).sort((a, b) => String(a.title).localeCompare(String(b.title)));
  if (!roots.length) {
    await joplin.views.dialogs.showMessageBox('No top-level notebooks found.');
    return;
  }

  let initialRoot = roots[0];
  if (initialFolderId && folderMap.has(initialFolderId)) {
    initialRoot = findRootFolder(folderMap.get(initialFolderId)!, folderMap);
  }

  let selectedRootId = initialRoot.id;
  let selectedCell = `${initialRoot.id}|1`;

  while (true) {
    const configs = await loadConfigsForRoots(roots);
    const handle = await joplin.views.dialogs.create(nextDialogId('autoIconAssignerMatrixManager'));
    await joplin.views.dialogs.setFitToContent(handle, false);
    await joplin.views.dialogs.setButtons(handle, readonly ? [
      { id: 'cancel', title: 'Close' },
    ] : [
      { id: 'choose', title: 'Choose icon for selected cell' },
      { id: 'backup', title: 'Backup selected scope' },
      { id: 'restore', title: 'Restore JSON' },
      { id: 'apply', title: 'Apply' },
      { id: 'cancel', title: 'Close' },
    ]);

    const headerCells = LEVEL_KEYS.map(level => `<th>${htmlEscape(levelLabel(level))}</th>`).join('');
    const rows = roots.map(root => {
      const config = configs.get(root.id) || emptyRootConfig(root);
      const cells = LEVEL_KEYS.map(level => {
        const value = `${root.id}|${level}`;
        const icon = config.icons[level];
        const fileName = config.sourceFileNames[level] || shortIconDescription(icon);
        return `<td>
          <label class="cell ${value === selectedCell ? 'selected' : ''}" title="${htmlEscape(fileName)}">
            <input type="radio" name="cell" value="${htmlEscape(value)}" ${value === selectedCell ? 'checked' : ''} ${readonly ? 'disabled' : ''}/>
            <span class="preview">${iconPreviewHtml(icon)}</span>
            <span class="cell-text">${htmlEscape(config.sourceFileNames[level] || (icon ? 'Stored icon' : 'Choose'))}</span>
          </label>
        </td>`;
      }).join('');

      return `<tr>
        <th class="root-name">${htmlEscape(root.title)}</th>
        ${cells}
        <td class="auto-cell"><label><input type="checkbox" name="auto_${htmlEscape(root.id)}" value="1" ${config.autoAssignOnCreation ? 'checked' : ''} ${readonly ? 'disabled' : ''}/> Auto</label></td>
      </tr>`;
    }).join('');

    await joplin.views.dialogs.setHtml(handle, `
      <style>
        :root { color-scheme: light dark; }
        html, body { max-width: 100%; max-height: 100%; }
        body {
          font-family: sans-serif;
          padding: 16px;
          margin: 0;
          color: var(--joplin-color, CanvasText);
          background: var(--joplin-background-color, Canvas);
          overflow: auto;
          box-sizing: border-box;
        }
        h2 { margin: 0 0 8px; }
        p, .hint { color: var(--joplin-color-faded, inherit); }
        .matrix-scroll {
          overflow: auto;
          max-height: calc(80vh - 210px);
          max-width: 100%;
          border: 1px solid var(--joplin-divider-color, GrayText);
          border-radius: 8px;
          padding: 6px;
        }
        table { border-collapse: separate; border-spacing: 6px; min-width: 760px; width: max-content; }
        th { text-align: left; font-weight: 600; }
        .root-name { min-width: 160px; max-width: 260px; }
        td, th { vertical-align: middle; }
        .cell {
          display: flex;
          gap: 8px;
          align-items: center;
          min-width: 125px;
          padding: 8px;
          border: 1px solid var(--joplin-divider-color, GrayText);
          border-radius: 8px;
          cursor: pointer;
          background: color-mix(in srgb, Canvas 88%, CanvasText 12%);
        }
        .cell:hover, .cell.selected, .cell:has(input:checked) {
          outline: 2px solid var(--joplin-color-correct, #4c9aff);
          background: color-mix(in srgb, Canvas 78%, Highlight 22%);
        }
        .cell input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
        .preview {
          width: 40px; height: 40px;
          display: inline-flex; align-items: center; justify-content: center;
          border: 1px solid var(--joplin-divider-color, GrayText);
          border-radius: 6px;
          background-color: #2a2a2a;
          background-image:
            linear-gradient(45deg, rgba(255,255,255,.12) 25%, transparent 25%),
            linear-gradient(-45deg, rgba(255,255,255,.12) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, rgba(255,255,255,.12) 75%),
            linear-gradient(-45deg, transparent 75%, rgba(255,255,255,.12) 75%);
          background-size: 12px 12px;
          background-position: 0 0, 0 6px, 6px -6px, -6px 0px;
        }
        img { width: 32px; height: 32px; object-fit: contain; filter: drop-shadow(0 0 2px rgba(0,0,0,.8)); }
        .no-icon { font-size: 24px; opacity: .75; }
        .cell-text { font-size: 12px; max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .controls {
          margin-top: 14px;
          padding: 12px;
          border: 1px solid var(--joplin-divider-color, GrayText);
          border-radius: 8px;
          position: sticky;
          bottom: 0;
          background: var(--joplin-background-color, Canvas);
        }
        .controls label { margin-right: 16px; }
        select { max-width: 280px; }
        .auto-cell { white-space: nowrap; }
      </style>
      <h2>${readonly ? 'Stored icons' : 'Auto Icon Assigner'}</h2>
      <p class="hint">Each row is one top-level notebook. Each row stores its own four level icons. Click a cell, then choose an icon for that exact notebook/level.</p>
      <form name="matrix">
        <div class="matrix-scroll">
          <table>
            <thead><tr><th>Top-level notebook</th>${headerCells}<th>New notebooks</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${readonly ? '' : `
        <div class="controls">
          <label>Apply scope:
            <select name="applyScope">
              <option value="selected">Selected top-level notebook only</option>
              <option value="all">All configured top-level notebooks</option>
            </select>
          </label>
          <label>Selected notebook for Apply:
            <select name="selectedRootId">${rootSelectOptions(roots, selectedRootId)}</select>
          </label>
          <label><input type="checkbox" name="overwriteExisting" value="1"/> Overwrite existing icons</label>
        </div>`}
      </form>
    `);

    const result = await joplin.views.dialogs.open(handle);
    if (result.id === 'cancel') return;

    const form = result.formData?.matrix || {};
    if (form.cell) selectedCell = String(form.cell);
    if (form.selectedRootId) selectedRootId = String(form.selectedRootId);
    await saveAutoAssignFlagsFromForm(roots, configs, form);

    if (readonly) return;

    const scope = form.applyScope || 'selected';
    const targetRoots = scope === 'all' ? roots : [roots.find(root => root.id === (form.selectedRootId || selectedRootId)) || initialRoot];

    if (result.id === 'backup') {
      const backup = await createIconBackupNote(targetRoots, 'manual backup from matrix');
      await joplin.views.dialogs.showMessageBox(`Backup note created in "${targetRoots[0].title}".

Folders backed up: ${backup.backup.folders.length}
JSON copied to clipboard: ${backup.copied ? 'yes' : 'no'}`);
      continue;
    }

    if (result.id === 'restore') {
      await restoreIconsFromBackupJsonDialog();
      continue;
    }

    if (result.id === 'choose') {
      const [rootId, levelRaw] = String(selectedCell).split('|');
      const level = (LEVEL_KEYS.includes(levelRaw as LevelKey) ? levelRaw : '1') as LevelKey;
      const root = roots.find(r => r.id === rootId) || initialRoot;
      const filePath = await pickIconForLevel(level);
      if (!filePath) continue;
      const config = await loadRootConfig(root.id) || emptyRootConfig(root);
      config.rootTitle = root.title;
      config.icons[level] = fileToFolderIconString(filePath);
      config.sourceFileNames[level] = path.basename(filePath);
      config.updatedAt = new Date().toISOString();
      await saveRootConfig(config);
      continue;
    }

    if (result.id === 'apply') {
      const overwriteExisting = form.overwriteExisting === '1' || form.overwriteExisting === 'on' || form.overwriteExisting === true;
      if (overwriteExisting) {
        const confirm = await joplin.views.dialogs.showMessageBox('Overwrite existing notebook icons?\n\nThis can replace manually assigned icons. Cancel to abort.');
        if (confirm !== 0) continue;
      }

      const backup = await createIconBackupNote(targetRoots, `automatic backup before matrix apply (${overwriteExisting ? 'overwrite existing' : 'skip existing'})`);
      const statsByRoot: Array<{ root: FolderEntity; stats: ApplyStats }> = [];
      for (const root of targetRoots) {
        const config = await loadRootConfig(root.id);
        if (!config) continue;
        const stats = await applyConfigToRoot(root, config, overwriteExisting);
        statsByRoot.push({ root, stats });
        console.info(`${PLUGIN_NAME}: Applied matrix config to ${root.title}`, stats);
      }
      await appendReportToBackupNote(backup.noteId, backup.body, statsByRoot);
      return;
    }
  }
}

async function selectedFolderIdOrMessage(): Promise<string | null> {
  const folder = await joplin.workspace.selectedFolder();
  if (!folder?.id) {
    await joplin.views.dialogs.showMessageBox('No selected notebook/folder found.');
    return null;
  }
  return folder.id;
}

let polling = false;
let pollTimer: NodeJS.Timeout | null = null;

async function pollForCreatedFolders(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const globalEnabled = await joplin.settings.value(SETTING_AUTO_ASSIGN);
    if (!globalEnabled) return;

    const previousCursor = await joplin.settings.value(SETTING_EVENT_CURSOR);
    const events = await joplin.data.get(['events'], previousCursor ? { cursor: previousCursor } : null);
    if (!previousCursor) {
      if (events?.cursor) await joplin.settings.setValue(SETTING_EVENT_CURSOR, events.cursor);
      return;
    }

    for (const event of events?.items || []) {
      if (event.item_type !== ITEM_TYPE_FOLDER || event.type !== EVENT_TYPE_CREATED) continue;
      await autoAssignCreatedFolder(event.item_id);
    }

    if (events?.cursor) await joplin.settings.setValue(SETTING_EVENT_CURSOR, events.cursor);
  } catch (error) {
    console.warn(`${PLUGIN_NAME}: folder creation polling failed`, error);
  } finally {
    polling = false;
  }
}

async function autoAssignCreatedFolder(folderId: string): Promise<void> {
  try {
    const folders = await getAllFolders();
    const folderMap = mapFolders(folders);
    const folder = folderMap.get(folderId) || await getFolder(folderId);
    const root = findRootFolder(folder, folderMap);
    const config = await loadRootConfig(root.id);
    if (!config || !config.autoAssignOnCreation) return;

    const relativeDepth = getRelativeDepth(folder, root, folderMap);
    const level = depthToLevelKey(relativeDepth);
    const icon = config.icons[level];
    if (!icon || folderHasIcon(folder)) return;

    await joplin.data.put(['folders', folder.id], null, { icon });
    console.info(`${PLUGIN_NAME}: Assigned ${levelLabel(level)} icon to ${folder.title}`);
  } catch (error) {
    console.error(`${PLUGIN_NAME}: failed to auto-assign created folder ${folderId}`, error);
  }
}

function getRelativeDepth(folder: FolderEntity, root: FolderEntity, folderMap: Map<string, FolderEntity>): number {
  if (folder.id === root.id) return 1;
  let depth = 1;
  let current: FolderEntity | undefined = folder;
  const visited = new Set<string>();
  while (current && current.id !== root.id && current.parent_id && !visited.has(current.id)) {
    visited.add(current.id);
    depth += 1;
    current = folderMap.get(current.parent_id);
  }
  return depth;
}

async function startPolling(): Promise<void> {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = Math.max(5, Number(await joplin.settings.value(SETTING_POLL_INTERVAL)) || 15);
  pollTimer = setInterval(() => void pollForCreatedFolders(), seconds * 1000);
  await pollForCreatedFolders();
}

async function registerSettings(): Promise<void> {
  await joplin.settings.registerSection(SETTINGS_SECTION, {
    label: PLUGIN_NAME,
    iconName: 'fas fa-icons',
  });

  const settings: Record<string, any> = {
    [SETTING_AUTO_ASSIGN]: {
      value: false,
      type: SettingItemType.Bool,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Globally enable auto-assigning icons to newly created notebooks',
      description: 'Each top-level notebook must also have a stored icon configuration with auto-assign enabled.',
    },
    [SETTING_POLL_INTERVAL]: {
      value: 15,
      type: SettingItemType.Int,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Folder creation polling interval, seconds',
      description: 'Joplin does not expose a dedicated folder-created workspace event, so the plugin polls the Data API events endpoint.',
      minimum: 5,
      maximum: 3600,
    },
    [SETTING_MATRIX_SUMMARY]: {
      value: 'The notebook icon matrix is shown in the modal opened from Tools > Auto Icon Assigner or the notebook right-click menu. Joplin plugin settings cannot embed a custom image grid directly.',
      type: SettingItemType.String,
      section: SETTINGS_SECTION,
      public: true,
      label: 'Icon matrix summary / note',
      description: 'Read-only note: Use the Tools menu or notebook right-click action to open the visual matrix. The rows below list per-notebook icon slots.',
    },
    [SETTING_EVENT_CURSOR]: {
      value: '',
      type: SettingItemType.String,
      section: SETTINGS_SECTION,
      public: false,
      label: 'Internal event cursor',
    },
  };

  // Joplin settings screens support form controls but not arbitrary custom HTML
  // grids. Register per-cell buttons to make the per-top-level-notebook x level
  // matrix visible and actionable inside Options > Settings.
  try {
    const folders = await getAllFolders();
    const roots = folders.filter(folder => !folder.parent_id).sort((a, b) => String(a.title).localeCompare(String(b.title)));
    for (const root of roots) {
      const config = await loadRootConfig(root.id) || emptyRootConfig(root);
      settings[`${SETTING_ROOT_AUTO_PREFIX}${root.id}`] = {
        value: !!config.autoAssignOnCreation,
        type: SettingItemType.Bool,
        section: SETTINGS_SECTION,
        public: true,
        label: `${root.title}: auto-assign newly created notebooks`,
        description: 'Per-top-level notebook toggle. The global auto-assign setting above must also be enabled.',
      };
      for (const level of LEVEL_KEYS) {
        const source = config.sourceFileNames[level] || (config.icons[level] ? 'stored icon' : 'not set');
        settings[`${SETTING_PICK_ICON_PREFIX}${root.id}.${level}`] = {
          value: source,
          type: SettingItemType.String,
          section: SETTINGS_SECTION,
          public: true,
          label: `${root.title} — ${levelLabel(level)}`,
          description: 'Read-only display of the stored icon filename/status for this top-level-notebook and hierarchy level. Change it from the matrix modal.',
        };
      }
    }
  } catch (error) {
    console.warn(`${PLUGIN_NAME}: Could not register dynamic per-notebook settings`, error);
  }

  await joplin.settings.registerSettings(settings);

  await joplin.settings.onChange(async (event: { keys: string[] }) => {
    for (const key of event.keys) {
      const autoInfo = parseRootAutoSettingKey(key);
      if (autoInfo) {
        const enabled = !!(await joplin.settings.value(key));
        await updateRootAutoAssign(autoInfo.rootId, enabled);
      }
    }
  });
}

async function registerCommandsAndMenus(): Promise<void> {
  const folderContextMenu = (MenuItemLocation as any).FolderContextMenu || 'folderContextMenu';
  const toolsMenu = (MenuItemLocation as any).Tools || 'tools';
  const submenuItems = [
    { commandName: 'autoIconAssignerConfigureAndApply' },
    { commandName: 'autoIconAssignerPreviewStoredSkipExisting' },
    { commandName: 'autoIconAssignerApplyStoredSkipExisting' },
    { commandName: 'autoIconAssignerApplyStoredOverwrite' },
    { commandName: 'autoIconAssignerViewStoredIcons' },
    { commandName: 'autoIconAssignerBackupSelectedRoot' },
    { commandName: 'autoIconAssignerBackupAllRoots' },
    { commandName: 'autoIconAssignerRestoreBackupJson' },
  ];

  await joplin.commands.register({
    name: 'autoIconAssignerConfigureAndApply',
    label: 'Auto Icon Assigner: Choose/configure icons…',
    execute: async (folderId?: string) => {
      const id = folderId || await selectedFolderIdOrMessage();
      if (id) await configureAndApply(id);
    },
  });

  await joplin.commands.register({
    name: 'autoIconAssignerPreviewStoredSkipExisting',
    label: 'Auto Icon Assigner: Preview stored icons; no changes',
    execute: async (folderId?: string) => {
      const id = folderId || await selectedFolderIdOrMessage();
      if (id) await previewStoredConfig(id, false);
    },
  });

  await joplin.commands.register({
    name: 'autoIconAssignerApplyStoredSkipExisting',
    label: 'Auto Icon Assigner: Apply stored icons; skip existing',
    execute: async (folderId?: string) => {
      const id = folderId || await selectedFolderIdOrMessage();
      if (id) await applyStoredConfig(id, false);
    },
  });

  await joplin.commands.register({
    name: 'autoIconAssignerApplyStoredOverwrite',
    label: 'Auto Icon Assigner: Apply stored icons; overwrite existing',
    execute: async (folderId?: string) => {
      const id = folderId || await selectedFolderIdOrMessage();
      if (id) await applyStoredConfig(id, true);
    },
  });

  await joplin.commands.register({
    name: 'autoIconAssignerViewStoredIcons',
    label: 'Auto Icon Assigner: View stored icon matrix',
    execute: async () => {
      await showStoredIconsViewer();
    },
  });


  await joplin.commands.register({
    name: 'autoIconAssignerBackupSelectedRoot',
    label: 'Auto Icon Assigner: Backup selected top-level notebook icons',
    execute: async (folderId?: string) => {
      await backupSelectedRoot(folderId);
    },
  });

  await joplin.commands.register({
    name: 'autoIconAssignerBackupAllRoots',
    label: 'Auto Icon Assigner: Backup all notebook icons',
    execute: async () => {
      await backupAllRoots();
    },
  });

  await joplin.commands.register({
    name: 'autoIconAssignerRestoreBackupJson',
    label: 'Auto Icon Assigner: Restore icons from backup JSON…',
    execute: async () => {
      await restoreIconsFromBackupJsonDialog();
    },
  });

  try {
    await joplin.views.menus.create('autoIconAssignerToolsMenu', 'Auto Icon Assigner', submenuItems, toolsMenu);
  } catch (error) {
    console.warn(`${PLUGIN_NAME}: Could not create Tools submenu; falling back to individual menu items`, error);
    await joplin.views.menuItems.create('autoIconAssignerToolsConfigure', 'autoIconAssignerConfigureAndApply', toolsMenu);
    await joplin.views.menuItems.create('autoIconAssignerToolsPreview', 'autoIconAssignerPreviewStoredSkipExisting', toolsMenu);
    await joplin.views.menuItems.create('autoIconAssignerToolsApplySkip', 'autoIconAssignerApplyStoredSkipExisting', toolsMenu);
    await joplin.views.menuItems.create('autoIconAssignerToolsApplyOverwrite', 'autoIconAssignerApplyStoredOverwrite', toolsMenu);
    await joplin.views.menuItems.create('autoIconAssignerToolsViewStored', 'autoIconAssignerViewStoredIcons', toolsMenu);
    await joplin.views.menuItems.create('autoIconAssignerToolsBackupSelected', 'autoIconAssignerBackupSelectedRoot', toolsMenu);
    await joplin.views.menuItems.create('autoIconAssignerToolsBackupAll', 'autoIconAssignerBackupAllRoots', toolsMenu);
    await joplin.views.menuItems.create('autoIconAssignerToolsRestoreBackup', 'autoIconAssignerRestoreBackupJson', toolsMenu);
  }

  // Single right-click entry. It opens the matrix modal, where icon picking,
  // skip/overwrite, apply scope, and auto-on-create can be managed.
  try {
    await joplin.views.menuItems.create('autoIconAssignerFolderConfigure', 'autoIconAssignerConfigureAndApply', folderContextMenu);
  } catch (fallbackError) {
    console.warn(`${PLUGIN_NAME}: Could not register folder context menu entry`, fallbackError);
  }
}

joplin.plugins.register({
  onStart: async function() {
    try {
      await registerSettings();
    } catch (error) {
      console.error(`${PLUGIN_NAME}: Failed to register settings`, error);
    }

    try {
      await registerCommandsAndMenus();
    } catch (error) {
      console.error(`${PLUGIN_NAME}: Failed to register commands/menus`, error);
      try {
        await joplin.views.dialogs.showMessageBox(`${PLUGIN_NAME} failed to register its commands/menus. Please check Joplin's log for details: ${String(error)}`);
      } catch (_) {}
    }

    try {
      await startPolling();
    } catch (error) {
      console.warn(`${PLUGIN_NAME}: Auto-assign polling was not started`, error);
    }
  },
});

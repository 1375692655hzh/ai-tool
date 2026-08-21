// 角色包管理：内置鲸鱼娘 + userData/characters/ 下的外置角色包
// 每个外置包是一个目录：character.json（描述类型/尺寸/状态映射）+ 素材文件
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { pathToFileURL } = require('url');

const BUILTIN = { id: 'whale-girl', name: '鲸鱼娘（默认）', width: 192, height: 208 };

function charactersDir() {
  return path.join(app.getPath('userData'), 'characters');
}

function listCharacters() {
  const out = [{ ...BUILTIN }];
  let dirs = [];
  try { dirs = fs.readdirSync(charactersDir(), { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(charactersDir(), d.name, 'character.json'), 'utf8'));
      if (j && j.id && j.type) out.push({ id: j.id, name: j.name || j.id });
    } catch { /* 无效包，跳过 */ }
  }
  return out;
}

// 返回完整角色配置（含素材基准路径）；null = 用渲染器内置的默认鲸鱼娘
function loadCharacter(id) {
  if (!id || id === BUILTIN.id) return null;
  try {
    const dir = path.join(charactersDir(), id);
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8'));
    if (j && j.type) {
      // 素材引用全部转成 file:// URL（中文/空格文件名自动百分号编码）。
      // 直接传 C:\ 原生路径或裸文件名，img.src/video.src 会按页面 URL 去解析而静默失败
      const abs = (f) => pathToFileURL(path.join(dir, f)).href;
      j.base = pathToFileURL(dir).href;
      if (j.file) j.file = abs(j.file);
      for (const st of Object.values(j.states || {})) {
        if (st.file) st.file = abs(st.file);
        if (Array.isArray(st.files)) st.files = st.files.map(abs);
      }
      return j;
    }
  } catch { /* 回退默认 */ }
  return null;
}

// 宠物窗口尺寸：角色基准尺寸 × 缩放
function petSizeFor(settings) {
  const ch = loadCharacter(settings.character);
  const scale = Number(settings.scale) || 1.5;
  return {
    width: Math.round((ch ? ch.width : BUILTIN.width) * scale),
    height: Math.round((ch ? ch.height : BUILTIN.height) * scale),
  };
}

module.exports = { listCharacters, loadCharacter, petSizeFor, BUILTIN };

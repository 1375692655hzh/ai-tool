// 宠物右键菜单：显示用量 / 形象切换 / 设置 / 启动工具 / 退出
const { Menu } = require('electron');

function popupPetMenu({
  tools, characters, currentCharacter,
  onShowUsage, onOpenSettings, onLaunchTool, onSetCharacter, onQuit,
}) {
  const toolItems = (tools && tools.length)
    ? tools.map((t) => ({ label: t.name, click: () => onLaunchTool(t) }))
    : [{ label: '（未配置，可在设置里添加）', enabled: false }];

  const charItems = (characters && characters.length
    ? characters
    : [{ id: 'whale-girl', name: '鲸鱼娘（默认）' }]
  ).map((c) => ({
    label: c.name,
    type: 'radio',
    checked: c.id === currentCharacter,
    click: () => onSetCharacter(c.id),
  }));

  const menu = Menu.buildFromTemplate([
    { label: '📊 显示用量', click: onShowUsage },
    { label: '🎭 形象', submenu: charItems },
    { label: '⚙️ 设置', click: onOpenSettings },
    // 没配置启动工具就不显示这一项，避免新用户点到空菜单
    ...((tools && tools.length) ? [{ label: '🚀 启动工具', submenu: toolItems }] : []),
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
  menu.popup();
}

module.exports = { popupPetMenu };

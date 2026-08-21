# 角色形象包

宠物的形象由「角色包」决定：内置 1 个（鲸鱼娘），其余放在
`%APPDATA%\ai-volume-pet\characters\` 下，每个子目录一个包。右键宠物 →「🎭 形象」即可切换（立即热切换，窗口按角色尺寸重建）。

## 目录结构

```
%APPDATA%\ai-volume-pet\characters\
└── my-char\
    ├── character.json     # 包描述（必需，缺了整个包被忽略）
    ├── idle_01.webm       # 素材文件（名称随意，json 里引用）
    └── ...
```

## character.json 格式

```jsonc
{
  "id": "my-char",              // 必需，与目录名一致
  "name": "我的角色",             // 右键菜单里显示的名字
  "type": "video",              // 三选一：spritesheet | video | static
  "width": 300, "height": 195,  // 展示尺寸（逻辑像素，窗口 = 此尺寸 × 缩放）

  // type=spritesheet 才有：
  "frameW": 288, "frameH": 395, // 单帧尺寸（网格切帧）
  "file": "strip.png",
  "states": {
    "idle":      { "row": 0, "frames": 8, "fps": 8, "loop": true }
    // row=第几行，frames=该行帧数
  },

  // type=video：每状态一组文件池（随机选），透明 webm
  "states": {
    "idle":   { "files": ["idle_01.webm", "idle_02.webm"], "loop": true },
    "waving": { "files": ["wave.webm"], "loop": false }
  },

  // type=static：静态立绘换图，bob=true 加呼吸浮动
  "states": {
    "idle":    { "files": ["daze.png"], "loop": true, "bob": true },
    "waving":  { "files": ["happy.png"], "hold": 2600 }
  }
}
```

## 三种渲染类型

| type | 适用 | 说明 |
|---|---|---|
| `spritesheet` | 网格排布的帧动画 | canvas 按行列切帧播放；性能最好，推荐首选 |
| `video` | 透明 webm 动作视频 | 隐藏 `<video>` 解码 + canvas 逐帧绘制（透明窗口里直接显示 video 会被合成器丢弃，务必走 canvas） |
| `static` | 静态立绘/PNG 差分 | 按状态换图；`bob: true` 呼吸浮动；非循环状态用 `hold` 毫秒数控制停留 |

## 状态名（动画钩子）

宠物交互会尝试播放以下状态，缺哪个就用当前状态继续（不报错），所以只实现 `idle` 也能用：

| 状态 | 触发时机 |
|---|---|
| `idle` | 默认待机（必需） |
| `running-left` / `running-right` | 随机散步 |
| `waving` | 单击 |
| `jumping` | 双击 |
| `drag` | 被鼠标拖拽时 |
| `waiting` | 长时间无互动发呆 |
| `failed` | 任一渠道查询失败时短暂播放 |
| `review` | 轮询查询中（可选） |

## 制作建议

- **尺寸**：`width/height` 按 1 倍缩放给逻辑像素（默认缩放 1.5×，设置里可调 1–2×）；单张 PNG 建议先压到 ~480px 高，避免解码内存过大
- **透明背景**：三种类型都要求素材透明背景（PNG/WebM alpha）
- **素材许可**：自制或确认可商用/个人使用后再放入；仓库默认素材的许可限制见 [NOTICE](../NOTICE.md)

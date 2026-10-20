export interface CoverGalleryPreset {
  id: string;
  title: string;
  fileName: string;
  category?: string;
}

export const COVER_GALLERY_PRESETS: readonly CoverGalleryPreset[] = Object.freeze([
  {
    id: "scribble-black-cat",
    title: "黑猫涂鸦",
    fileName: "scribble-black-cat.jpg",
    category: "default",
  },
  {
    id: "blue-island-watercolor",
    title: "蓝岛水彩",
    fileName: "blue-island-watercolor.jpg",
    category: "default",
  },
  {
    id: "nature-plate-print",
    title: "自然版画",
    fileName: "nature-plate-print.jpg",
    category: "default",
  },
  {
    id: "pastel-spring-bookmark",
    title: "春日书签",
    fileName: "pastel-spring-bookmark.jpg",
    category: "default",
  },
  {
    id: "hidden-ragdoll-cat",
    title: "灌木小猫",
    fileName: "hidden-ragdoll-cat.jpg",
    category: "default",
  },
  {
    id: "grass-horizon-dream",
    title: "草地地平线",
    fileName: "grass-horizon-dream.jpg",
    category: "default",
  },
  {
    id: "bamboo-shadow-minimal",
    title: "竹影留白",
    fileName: "bamboo-shadow-minimal.jpg",
    category: "default",
  },
  {
    id: "green-plain-clouds",
    title: "绿色平原",
    fileName: "green-plain-clouds.jpg",
    category: "default",
  },
  {
    id: "four-seasons-storybook",
    title: "四季绘本",
    fileName: "four-seasons-storybook.jpg",
    category: "default",
  },
  {
    id: "pink-flower-fisherman",
    title: "花雨小舟",
    fileName: "pink-flower-fisherman.jpg",
    category: "default",
  },
  {
    id: "sunlit-window-leaves",
    title: "窗外晴叶",
    fileName: "sunlit-window-leaves.jpg",
    category: "default",
  },
  {
    id: "summer-sea-fantasy",
    title: "夏海幻想",
    fileName: "summer-sea-fantasy.jpg",
    category: "default",
  },
  {
    id: "maximalist-four-seasons",
    title: "繁花四季",
    fileName: "maximalist-four-seasons.jpg",
    category: "default",
  },
  {
    id: "story-garden-objects",
    title: "园中物语",
    fileName: "story-garden-objects.jpg",
    category: "default",
  },
  {
    id: "blue-sky-screenprint",
    title: "蓝天版画",
    fileName: "blue-sky-screenprint.jpg",
    category: "default",
  },
  {
    id: "indigo-window-silhouette",
    title: "靛窗花影",
    fileName: "indigo-window-silhouette.jpg",
    category: "default",
  },
  {
    id: "spring-gauze-room",
    title: "春纱小室",
    fileName: "spring-gauze-room.jpg",
    category: "default",
  },
  {
    id: "felt-blue-storybook",
    title: "蓝毡绘本",
    fileName: "felt-blue-storybook.jpg",
    category: "default",
  },
  {
    id: "rainy-street-cafe",
    title: "雨街咖啡",
    fileName: "rainy-street-cafe.jpg",
    category: "default",
  },
  {
    id: "dragon-pillar-palace",
    title: "龙柱古殿",
    fileName: "dragon-pillar-palace.jpg",
    category: "default",
  },
  {
    id: "wasteland-rider",
    title: "废土骑士",
    fileName: "wasteland-rider.jpg",
    category: "default",
  },
  {
    id: "white-cat-blossom",
    title: "花间白猫",
    fileName: "white-cat-blossom.jpg",
    category: "default",
  },
  {
    id: "tree-lined-path",
    title: "林荫步道",
    fileName: "tree-lined-path.jpg",
    category: "default",
  },
  {
    id: "ochre-silhouette",
    title: "赭墨剪影",
    fileName: "ochre-silhouette.jpg",
    category: "default",
  },
  {
    id: "misty-blossoms",
    title: "薄雾繁花",
    fileName: "misty-blossoms.jpg",
    category: "default",
  },
].map((item) => Object.freeze(item)));

const COVER_GALLERY_PRESET_BY_ID = new Map(COVER_GALLERY_PRESETS.map((preset) => [preset.id, preset]));

export function getCoverGalleryPreset(presetId: unknown): CoverGalleryPreset | null {
  if (typeof presetId !== "string" || !presetId.trim()) return null;
  return COVER_GALLERY_PRESET_BY_ID.get(presetId.trim()) || null;
}

export function listCoverGalleryPresets() {
  return COVER_GALLERY_PRESETS;
}

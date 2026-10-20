import { COVER_GALLERY_PRESETS, type CoverGalleryPreset } from '../../../../../shared/cover-gallery-presets.ts';
import bambooShadowMinimal from '../../../assets/cover-gallery/bamboo-shadow-minimal.jpg';
import blueSkyScreenprint from '../../../assets/cover-gallery/blue-sky-screenprint.jpg';
import blueIslandWatercolor from '../../../assets/cover-gallery/blue-island-watercolor.jpg';
import feltBlueStorybook from '../../../assets/cover-gallery/felt-blue-storybook.jpg';
import fourSeasonsStorybook from '../../../assets/cover-gallery/four-seasons-storybook.jpg';
import grassHorizonDream from '../../../assets/cover-gallery/grass-horizon-dream.jpg';
import greenPlainClouds from '../../../assets/cover-gallery/green-plain-clouds.jpg';
import hiddenRagdollCat from '../../../assets/cover-gallery/hidden-ragdoll-cat.jpg';
import indigoWindowSilhouette from '../../../assets/cover-gallery/indigo-window-silhouette.jpg';
import maximalistFourSeasons from '../../../assets/cover-gallery/maximalist-four-seasons.jpg';
import naturePlatePrint from '../../../assets/cover-gallery/nature-plate-print.jpg';
import pastelSpringBookmark from '../../../assets/cover-gallery/pastel-spring-bookmark.jpg';
import pinkFlowerFisherman from '../../../assets/cover-gallery/pink-flower-fisherman.jpg';
import scribbleBlackCat from '../../../assets/cover-gallery/scribble-black-cat.jpg';
import springGauzeRoom from '../../../assets/cover-gallery/spring-gauze-room.jpg';
import storyGardenObjects from '../../../assets/cover-gallery/story-garden-objects.jpg';
import summerSeaFantasy from '../../../assets/cover-gallery/summer-sea-fantasy.jpg';
import sunlitWindowLeaves from '../../../assets/cover-gallery/sunlit-window-leaves.jpg';
import rainyStreetCafe from '../../../assets/cover-gallery/rainy-street-cafe.jpg';
import dragonPillarPalace from '../../../assets/cover-gallery/dragon-pillar-palace.jpg';
import wastelandRider from '../../../assets/cover-gallery/wasteland-rider.jpg';
import whiteCatBlossom from '../../../assets/cover-gallery/white-cat-blossom.jpg';
import treeLinedPath from '../../../assets/cover-gallery/tree-lined-path.jpg';
import ochreSilhouette from '../../../assets/cover-gallery/ochre-silhouette.jpg';
import mistyBlossoms from '../../../assets/cover-gallery/misty-blossoms.jpg';

export interface CoverGalleryItem extends CoverGalleryPreset {
  src: string;
}

const COVER_GALLERY_IMAGE_URLS: Record<string, string> = {
  'bamboo-shadow-minimal': bambooShadowMinimal,
  'blue-sky-screenprint': blueSkyScreenprint,
  'blue-island-watercolor': blueIslandWatercolor,
  'felt-blue-storybook': feltBlueStorybook,
  'four-seasons-storybook': fourSeasonsStorybook,
  'grass-horizon-dream': grassHorizonDream,
  'green-plain-clouds': greenPlainClouds,
  'hidden-ragdoll-cat': hiddenRagdollCat,
  'indigo-window-silhouette': indigoWindowSilhouette,
  'maximalist-four-seasons': maximalistFourSeasons,
  'nature-plate-print': naturePlatePrint,
  'pastel-spring-bookmark': pastelSpringBookmark,
  'pink-flower-fisherman': pinkFlowerFisherman,
  'scribble-black-cat': scribbleBlackCat,
  'spring-gauze-room': springGauzeRoom,
  'story-garden-objects': storyGardenObjects,
  'summer-sea-fantasy': summerSeaFantasy,
  'sunlit-window-leaves': sunlitWindowLeaves,
  'rainy-street-cafe': rainyStreetCafe,
  'dragon-pillar-palace': dragonPillarPalace,
  'wasteland-rider': wastelandRider,
  'white-cat-blossom': whiteCatBlossom,
  'tree-lined-path': treeLinedPath,
  'ochre-silhouette': ochreSilhouette,
  'misty-blossoms': mistyBlossoms,
} satisfies Record<string, string>;

export const COVER_GALLERY_ITEMS: CoverGalleryItem[] = Array.from(COVER_GALLERY_PRESETS, (preset) => {
  const src = COVER_GALLERY_IMAGE_URLS[preset.id];
  if (!src) {
    throw new Error(`Missing cover gallery asset import for preset: ${preset.id}`);
  }
  return { ...preset, src };
});

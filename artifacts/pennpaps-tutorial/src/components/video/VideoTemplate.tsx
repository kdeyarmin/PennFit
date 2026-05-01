import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';

// Scene timings — chosen so a first-time viewer can comfortably read every
// line of body copy at least once AND have a few seconds of "all text on
// screen" hold time before the next scene takes over. Earlier versions ran
// at 21s and 43s; viewers still reported text "flashing past". The values
// below run ~58s — each scene now holds for 4-6 seconds after its final
// text element animates in.
export const SCENE_DURATIONS = {
  intro: 7000,
  capture_measure: 14000,
  pro_tips: 14000,
  questionnaire_results: 16000,
  outro: 6500,
};

const SCENE_COMPONENTS: Record<string, React.ComponentType> = {
  intro: Scene1,
  capture_measure: Scene2,
  pro_tips: Scene3,
  questionnaire_results: Scene4,
  outro: Scene5,
};

interface VideoTemplateProps {
  durations?: Record<string, number>;
  loop?: boolean;
  onSceneChange?: (sceneKey: string) => void;
}

export default function VideoTemplate({
  durations = SCENE_DURATIONS,
  loop = true,
  onSceneChange,
}: VideoTemplateProps = {}) {
  const { currentSceneKey } = useVideoPlayer({ durations, loop });

  useEffect(() => {
    onSceneChange?.(currentSceneKey);
  }, [currentSceneKey, onSceneChange]);

  const baseSceneKey = currentSceneKey.replace(/_r[12]$/, '');
  const SceneComponent = SCENE_COMPONENTS[baseSceneKey];

  return (
    <div className="relative w-full h-full overflow-hidden bg-[var(--color-bg-light)]">

      {/* Persistent Background Layer */}
      <div className="absolute inset-0 z-0">
        <motion.div
          className="absolute inset-0 bg-cover bg-center opacity-40"
          style={{ backgroundImage: `url(${import.meta.env.BASE_URL}images/bg-abstract.png)` }}
          animate={{
            scale: [1.05, 1.1, 1.05],
            x: ['0%', '-2%', '0%'],
            y: ['0%', '1%', '0%']
          }}
          transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut' }}
        />

        {/* Animated gradient orbs for extra depth */}
        <motion.div
          className="absolute top-0 left-0 w-[800px] h-[800px] rounded-full blur-[120px] mix-blend-multiply opacity-30 pointer-events-none"
          style={{ background: 'radial-gradient(circle, #F4B942, transparent)' }}
          animate={{
            x: ['-20%', '30%', '-20%'],
            y: ['-20%', '10%', '-20%']
          }}
          transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute bottom-0 right-0 w-[600px] h-[600px] rounded-full blur-[100px] mix-blend-multiply opacity-20 pointer-events-none"
          style={{ background: 'radial-gradient(circle, #1F3A5C, transparent)' }}
          animate={{
            x: ['20%', '-10%', '20%'],
            y: ['20%', '-20%', '20%']
          }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>

      {/* Foreground Scenes */}
      <AnimatePresence initial={false} mode="wait">
        {SceneComponent && <SceneComponent key={currentSceneKey} />}
      </AnimatePresence>

    </div>
  );
}

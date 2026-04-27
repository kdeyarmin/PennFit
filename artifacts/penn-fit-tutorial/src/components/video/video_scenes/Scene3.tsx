import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Sun, Ruler, Glasses, MessageCircleQuestion, Lightbulb } from 'lucide-react';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    // Stretched ramp so each tip card has a clear arrival moment instead of
    // four rectangles flying in at once. Final hold gives ~4.5s of read
    // time with all four tips on screen (scene total: 14s).
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 3200),
      setTimeout(() => setPhase(4), 5000),
      setTimeout(() => setPhase(5), 6800),
      setTimeout(() => setPhase(6), 9500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const tips = [
    { id: 1, Icon: Sun, text: "Face a window for bright, even lighting" },
    { id: 2, Icon: Ruler, text: "Hold device at eye level and arm's length" },
    { id: 3, Icon: Glasses, text: "Remove glasses and tie hair back" },
    { id: 4, Icon: MessageCircleQuestion, text: "Answer honestly — \u201CI'm not sure\u201D is fine" },
  ];

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center bg-[#1F3A5C]"
      initial={{ x: '100%' }}
      animate={{ x: '0%' }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Decorative background shapes */}
      <motion.div 
        className="absolute -right-20 -top-20 w-[40vw] h-[40vw] rounded-full bg-[#F4B942]/10 blur-3xl"
        animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.8, 0.5] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="w-full max-w-5xl px-4 sm:px-8 lg:px-12 z-10 flex flex-col items-center">
        
        <motion.div
          className="inline-flex items-center gap-2 sm:gap-3 px-4 sm:px-6 py-2 sm:py-3 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 mb-6 sm:mb-10 lg:mb-12 max-w-full"
          initial={{ opacity: 0, y: -20 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: -20 }}
        >
          <Lightbulb className="w-4 h-4 sm:w-5 sm:h-5 text-[#F4B942] shrink-0" strokeWidth={2.5} />
          <span className="text-[#F4B942] font-semibold tracking-[0.18em] uppercase text-[11px] sm:text-sm whitespace-nowrap">
            Pro Tips for Accuracy
          </span>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-5 lg:gap-6 w-full">
          {tips.map((tip, index) => {
            const { Icon } = tip;
            return (
              <motion.div
                key={tip.id}
                className="bg-white/5 border border-white/10 p-4 sm:p-5 lg:p-7 rounded-2xl sm:rounded-3xl backdrop-blur-md flex items-center gap-3 sm:gap-4 lg:gap-5 min-w-0"
                initial={{ opacity: 0, x: index % 2 === 0 ? -40 : 40, rotateX: 45 }}
                animate={phase >= index + 2 ? { opacity: 1, x: 0, rotateX: 0 } : { opacity: 0, x: index % 2 === 0 ? -40 : 40, rotateX: 45 }}
                transition={{ type: 'spring', stiffness: 150, damping: 20 }}
                style={{ transformPerspective: 1000 }}
              >
                <div className="shrink-0 w-10 h-10 sm:w-12 sm:h-12 lg:w-14 lg:h-14 rounded-xl sm:rounded-2xl bg-[#F4B942]/15 border border-[#F4B942]/30 flex items-center justify-center">
                  <Icon className="w-5 h-5 sm:w-6 sm:h-6 lg:w-7 lg:h-7 text-[#F4B942]" strokeWidth={2} />
                </div>
                <p className="text-white text-sm sm:text-base lg:text-lg leading-snug font-medium min-w-0 flex-1">
                  {tip.text}
                </p>
              </motion.div>
            );
          })}
        </div>

      </div>
    </motion.div>
  );
}

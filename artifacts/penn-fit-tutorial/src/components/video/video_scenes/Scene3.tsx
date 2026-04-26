import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 600),
      setTimeout(() => setPhase(3), 1200),
      setTimeout(() => setPhase(4), 1800),
      setTimeout(() => setPhase(5), 2400),
      setTimeout(() => setPhase(6), 4000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const tips = [
    { id: 1, icon: "☀️", text: "Face a window for bright, even lighting" },
    { id: 2, icon: "📏", text: "Hold device at eye level & arm's length" },
    { id: 3, icon: "👓", text: "Remove glasses & tie hair back" },
    { id: 4, icon: "🤔", text: "Answer honestly (guess-free is okay!)" },
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

      <div className="w-full max-w-5xl px-12 z-10 flex flex-col items-center">
        
        <motion.div
          className="inline-flex items-center gap-3 px-6 py-3 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 mb-12"
          initial={{ opacity: 0, y: -20 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: -20 }}
        >
          <span className="text-2xl">💡</span>
          <span className="text-[#F4B942] font-semibold tracking-widest uppercase">Pro Tips for Accuracy</span>
        </motion.div>

        <div className="grid grid-cols-2 gap-8 w-full">
          {tips.map((tip, index) => (
            <motion.div
              key={tip.id}
              className="bg-white/5 border border-white/10 p-8 rounded-3xl backdrop-blur-md flex items-start gap-6"
              initial={{ opacity: 0, x: index % 2 === 0 ? -40 : 40, rotateX: 45 }}
              animate={phase >= index + 2 ? { opacity: 1, x: 0, rotateX: 0 } : { opacity: 0, x: index % 2 === 0 ? -40 : 40, rotateX: 45 }}
              transition={{ type: 'spring', stiffness: 150, damping: 20 }}
              style={{ transformPerspective: 1000 }}
            >
              <div className="text-4xl">{tip.icon}</div>
              <p className="text-white text-xl leading-snug font-medium mt-1">
                {tip.text}
              </p>
            </motion.div>
          ))}
        </div>

      </div>
    </motion.div>
  );
}

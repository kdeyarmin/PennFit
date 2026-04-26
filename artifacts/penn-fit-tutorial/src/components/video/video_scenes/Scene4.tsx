import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 1800),
      setTimeout(() => setPhase(4), 2600),
      setTimeout(() => setPhase(5), 3500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center"
      initial={{ opacity: 0, filter: 'blur(20px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      exit={{ y: '-100%', opacity: 0 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="w-full max-w-6xl px-12 grid grid-cols-2 gap-16 items-center">
        
        {/* Left: Text */}
        <div className="space-y-10">
          <div>
            <motion.h2 
              className="text-[#F4B942] font-bold tracking-wider uppercase text-sm mb-2"
              initial={{ opacity: 0, x: -20 }}
              animate={phase >= 1 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
            >
              Step 3 & 4
            </motion.h2>
            <motion.h3 
              className="text-5xl font-extrabold text-[#1F3A5C] leading-tight"
              style={{ fontFamily: 'var(--font-display)' }}
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            >
              Details &<br/>Results
            </motion.h3>
          </div>

          <div className="space-y-6">
            <motion.div 
              className="flex items-start gap-4"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            >
              <div className="w-8 h-8 rounded-full bg-[#1F3A5C]/10 flex items-center justify-center shrink-0 mt-1">
                <span className="text-[#1F3A5C] font-bold">3</span>
              </div>
              <p className="text-xl text-[#475569] leading-relaxed">
                Answer 11 quick clinical questions. <br/>
                <span className="font-semibold text-[#1F3A5C]">Not sure of your pressure? Just say so.</span>
              </p>
            </motion.div>

            <motion.div 
              className="flex items-start gap-4"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 4 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            >
              <div className="w-8 h-8 rounded-full bg-[#F4B942]/20 flex items-center justify-center shrink-0 mt-1">
                <span className="text-[#F4B942] font-bold">4</span>
              </div>
              <p className="text-xl text-[#475569] leading-relaxed">
                Get your top 3 mask recommendations with confidence scores.
              </p>
            </motion.div>
          </div>
        </div>

        {/* Right: Results UI Mockup */}
        <div className="relative aspect-[4/5] rounded-[3rem] bg-white border border-gray-100 shadow-2xl flex flex-col p-8 overflow-hidden">
          <motion.div 
            className="w-full h-32 rounded-2xl bg-[#1F3A5C]/5 mb-6 animate-pulse"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={phase >= 3 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
          />
          
          <div className="space-y-4">
            {[1, 2, 3].map((item, i) => (
              <motion.div 
                key={item}
                className="w-full p-4 rounded-xl border border-gray-100 flex items-center gap-4 bg-white shadow-sm"
                initial={{ opacity: 0, x: 40 }}
                animate={phase >= 4 ? { opacity: 1, x: 0 } : { opacity: 0, x: 40 }}
                transition={{ delay: i * 0.15 + (phase >= 4 ? 0 : 0) }}
              >
                <div className="w-12 h-12 rounded-full bg-[#1F3A5C]/10 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="w-2/3 h-3 rounded-full bg-gray-200" />
                  <div className="w-1/3 h-2 rounded-full bg-gray-100" />
                </div>
                <div className="text-[#F4B942] font-bold text-lg">{98 - i * 4}%</div>
              </motion.div>
            ))}
          </div>
        </div>

      </div>
    </motion.div>
  );
}

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
      <div className="w-full max-w-6xl px-5 sm:px-8 lg:px-12 grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 items-center">
        
        {/* Left: Text */}
        <div className="space-y-6 lg:space-y-10 text-center lg:text-left order-2 lg:order-1">
          <div>
            <motion.h2 
              className="text-[#F4B942] font-bold tracking-wider uppercase text-xs sm:text-sm mb-2"
              initial={{ opacity: 0, x: -20 }}
              animate={phase >= 1 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
            >
              Step 3 & 4
            </motion.h2>
            <motion.h3 
              className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#1F3A5C] leading-[1.05] tracking-tight"
              style={{ fontFamily: 'var(--font-display)' }}
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            >
              Details & Results
            </motion.h3>
          </div>

          <div className="space-y-4 sm:space-y-6">
            <motion.div 
              className="flex items-start gap-3 sm:gap-4 text-left max-w-md mx-auto lg:mx-0"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            >
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-[#1F3A5C]/10 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-[#1F3A5C] font-bold text-sm sm:text-base">3</span>
              </div>
              <div className="space-y-1 sm:space-y-1.5 min-w-0">
                <p className="text-base sm:text-lg lg:text-xl text-[#475569] leading-snug sm:leading-relaxed">
                  Answer 11 quick clinical questions.
                </p>
                <p className="text-sm sm:text-base font-semibold text-[#1F3A5C] leading-snug">
                  Not sure of your pressure? Just say so.
                </p>
              </div>
            </motion.div>

            <motion.div 
              className="flex items-start gap-3 sm:gap-4 text-left max-w-md mx-auto lg:mx-0"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 4 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            >
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-[#F4B942]/20 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-[#F4B942] font-bold text-sm sm:text-base">4</span>
              </div>
              <p className="text-base sm:text-lg lg:text-xl text-[#475569] leading-snug sm:leading-relaxed">
                Get your top 3 mask recommendations with confidence scores.
              </p>
            </motion.div>
          </div>
        </div>

        {/* Right: Results UI Mockup */}
        <div className="relative aspect-[4/5] w-full max-w-[180px] sm:max-w-[240px] lg:max-w-none mx-auto rounded-2xl sm:rounded-[2rem] lg:rounded-[3rem] bg-white border border-gray-100 shadow-2xl flex flex-col p-3 sm:p-5 lg:p-8 overflow-hidden order-1 lg:order-2">
          <motion.div 
            className="w-full h-12 sm:h-20 lg:h-32 rounded-xl lg:rounded-2xl bg-[#1F3A5C]/5 mb-3 sm:mb-4 lg:mb-6 animate-pulse"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={phase >= 3 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
          />
          
          <div className="space-y-2 sm:space-y-3 lg:space-y-4">
            {[1, 2, 3].map((item, i) => (
              <motion.div 
                key={item}
                className="w-full p-2 sm:p-3 lg:p-4 rounded-lg lg:rounded-xl border border-gray-100 flex items-center gap-2 sm:gap-3 lg:gap-4 bg-white shadow-sm"
                initial={{ opacity: 0, x: 40 }}
                animate={phase >= 4 ? { opacity: 1, x: 0 } : { opacity: 0, x: 40 }}
                transition={{ delay: i * 0.15 + (phase >= 4 ? 0 : 0) }}
              >
                <div className="w-6 h-6 sm:w-9 sm:h-9 lg:w-12 lg:h-12 rounded-full bg-[#1F3A5C]/10 flex-shrink-0" />
                <div className="flex-1 space-y-1 sm:space-y-1.5 lg:space-y-2 min-w-0">
                  <div className="w-2/3 h-2 sm:h-2.5 lg:h-3 rounded-full bg-gray-200" />
                  <div className="w-1/3 h-1.5 sm:h-2 rounded-full bg-gray-100" />
                </div>
                <div className="text-[#F4B942] font-bold text-xs sm:text-sm lg:text-lg">{98 - i * 4}%</div>
              </motion.div>
            ))}
          </div>
        </div>

      </div>
    </motion.div>
  );
}

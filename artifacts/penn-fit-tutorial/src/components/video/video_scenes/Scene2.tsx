import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 800),
      setTimeout(() => setPhase(3), 1600),
      setTimeout(() => setPhase(4), 2400),
      setTimeout(() => setPhase(5), 3500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center"
      initial={{ clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ clipPath: 'circle(150% at 50% 50%)' }}
      exit={{ opacity: 0, scale: 1.05 }}
      transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="w-full max-w-6xl px-12 grid grid-cols-2 gap-16 items-center">
        
        {/* Left Side: Graphic / Visual */}
        <div className="relative aspect-square rounded-[3rem] bg-[#1F3A5C] overflow-hidden flex items-center justify-center shadow-2xl">
          <motion.div 
            className="absolute inset-0 opacity-40 bg-cover bg-center"
            style={{ backgroundImage: `url(${import.meta.env.BASE_URL}images/face-mesh.png)` }}
            animate={{ scale: [1, 1.1, 1], rotate: [0, 2, -2, 0] }}
            transition={{ duration: 15, repeat: Infinity, ease: 'linear' }}
          />
          
          <motion.div 
            className="relative z-10 w-48 h-64 border-4 border-[#F4B942]/80 rounded-[2.5rem] flex flex-col items-center justify-center"
            initial={{ scale: 0, rotate: -15 }}
            animate={phase >= 1 ? { scale: 1, rotate: 0 } : { scale: 0, rotate: -15 }}
            transition={{ type: 'spring', stiffness: 200, damping: 20 }}
          >
            {/* Phone screen UI mockup */}
            <div className="w-full h-full p-4 flex flex-col justify-between">
              <motion.div 
                className="w-16 h-16 mx-auto rounded-full border-2 border-dashed border-white/50"
                animate={phase >= 2 ? { scale: [1, 1.2, 1], borderColor: ['rgba(255,255,255,0.5)', '#F4B942', 'rgba(255,255,255,0.5)'] } : {}}
                transition={{ duration: 2, repeat: Infinity }}
              />
              <motion.div 
                className="w-full h-2 bg-white/20 rounded-full overflow-hidden"
                initial={{ opacity: 0 }}
                animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
              >
                <motion.div 
                  className="h-full bg-[#F4B942]"
                  initial={{ width: '0%' }}
                  animate={phase >= 3 ? { width: '100%' } : { width: '0%' }}
                  transition={{ duration: 1.5, ease: 'easeInOut' }}
                />
              </motion.div>
            </div>
          </motion.div>
        </div>

        {/* Right Side: Text Content */}
        <div className="space-y-10">
          <div>
            <motion.h2 
              className="text-[#F4B942] font-bold tracking-wider uppercase text-sm mb-2"
              initial={{ opacity: 0, x: -20 }}
              animate={phase >= 1 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
            >
              Step 1 & 2
            </motion.h2>
            <motion.h3 
              className="text-5xl font-extrabold text-[#1F3A5C] leading-tight"
              style={{ fontFamily: 'var(--font-display)' }}
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.6 }}
            >
              Capture &<br/>Measure
            </motion.h3>
          </div>

          <div className="space-y-6">
            <motion.div 
              className="flex items-start gap-4"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.5 }}
            >
              <div className="w-8 h-8 rounded-full bg-[#1F3A5C]/10 flex items-center justify-center shrink-0 mt-1">
                <span className="text-[#1F3A5C] font-bold">1</span>
              </div>
              <p className="text-xl text-[#475569] leading-relaxed">
                Hold your device at eye level.<br/>A 3-second timer takes your photo.
              </p>
            </motion.div>

            <motion.div 
              className="flex items-start gap-4"
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 4 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.5 }}
            >
              <div className="w-8 h-8 rounded-full bg-[#F4B942]/20 flex items-center justify-center shrink-0 mt-1">
                <span className="text-[#F4B942] font-bold">2</span>
              </div>
              <p className="text-xl text-[#475569] leading-relaxed">
                Our on-device AI instantly extracts 5 key facial measurements.
              </p>
            </motion.div>
          </div>
        </div>

      </div>
    </motion.div>
  );
}

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import logoSrc from '../../../../../../attached_assets/IMG_2053_1777233708393.jpeg';

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    // Slower phase ramp — give viewers a beat to actually look at each piece
    // (logo → title → tagline) before the next one slides in.
    const timers = [
      setTimeout(() => setPhase(1), 400),   // Logo lands
      setTimeout(() => setPhase(2), 1500),  // "PennPaps" title
      setTimeout(() => setPhase(3), 2600),  // "How to Use" badge
      setTimeout(() => setPhase(4), 5200),  // Elements start exiting
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center bg-transparent"
      initial={{ opacity: 0, scale: 1.05 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="relative z-10 flex flex-col items-center justify-center w-full">
        {/* Logo container */}
        <motion.div
          className="relative overflow-hidden rounded-2xl shadow-2xl bg-white flex items-center justify-center p-8"
          initial={{ scale: 0.8, opacity: 0, y: 40 }}
          animate={
            phase >= 1 
              ? { scale: 1, opacity: 1, y: -20 } 
              : { scale: 0.8, opacity: 1, y: 40 }
          }
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        >
          <img 
            src={logoSrc} 
            alt="PennPaps Logo" 
            className="w-32 sm:w-40 md:w-56 lg:w-64 object-contain"
          />
        </motion.div>

        {/* Title */}
        <motion.h1 
          className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold text-[#1F3A5C] mt-6 sm:mt-8 tracking-tight leading-none"
          style={{ fontFamily: 'var(--font-display)' }}
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          PennPaps
        </motion.h1>

        {/* Subtitle */}
        <motion.div
          className="mt-4 sm:mt-5 px-4 sm:px-6 py-1.5 sm:py-2 rounded-full bg-[#F4B942]/10 border border-[#F4B942]/30"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={phase >= 3 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.5 }}
        >
          <p className="text-sm sm:text-base md:text-lg font-semibold text-[#1F3A5C] uppercase tracking-[0.2em]">
            How to Use
          </p>
        </motion.div>
      </div>
    </motion.div>
  );
}

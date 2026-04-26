import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import logoSrc from '../../../../../../attached_assets/IMG_2053_1777233708393.jpeg';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 400),
      setTimeout(() => setPhase(2), 1200),
      setTimeout(() => setPhase(3), 2000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center bg-[#1F3A5C]"
      initial={{ scale: 1.1, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1, ease: 'easeOut' }}
    >
      {/* Background glow */}
      <motion.div 
        className="absolute inset-0 flex items-center justify-center"
        animate={{ scale: [1, 1.05, 1], opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <div className="w-[60vw] h-[60vw] rounded-full bg-[#F4B942]/20 blur-[100px]" />
      </motion.div>

      <div className="relative z-10 flex flex-col items-center text-center px-5 sm:px-8 lg:px-12 max-w-4xl">
        <motion.div
          className="bg-white p-4 sm:p-6 lg:p-8 rounded-2xl lg:rounded-3xl shadow-2xl mb-6 sm:mb-8 lg:mb-12"
          initial={{ opacity: 0, y: 40, rotateX: 30 }}
          animate={phase >= 1 ? { opacity: 1, y: 0, rotateX: 0 } : { opacity: 0, y: 40, rotateX: 30 }}
          transition={{ type: 'spring', stiffness: 150, damping: 20 }}
          style={{ transformPerspective: 1000 }}
        >
          <img src={logoSrc} alt="Penn Home Medical Supply" className="w-36 sm:w-48 lg:w-64 object-contain" />
        </motion.div>

        <motion.h2 
          className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-medium text-white tracking-tight leading-tight"
          style={{ fontFamily: 'var(--font-display)' }}
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.8 }}
        >
          Your perfect CPAP mask,
        </motion.h2>

        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={phase >= 3 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 200, damping: 15 }}
        >
          <h2 
            className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-[#F4B942] mt-1 tracking-tight leading-tight"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            in minutes.
          </h2>
        </motion.div>
      </div>
    </motion.div>
  );
}

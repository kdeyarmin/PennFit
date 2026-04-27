import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Camera, ScanFace, Ruler } from 'lucide-react';

// Use the home-page screenshot — it's the actual entry point patients see when
// they open Penn Fit (Step 1 of this scene's narrative). The cpap-fitter capture
// page itself can't be screenshotted in headless because it requires a working
// camera permission.
const homeScreenshot = `${import.meta.env.BASE_URL}screenshots/home-mobile.jpg`;

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    // Reveals stretched to ~9.5s so each step lingers ~1.7-2s before the
    // next one arrives. Scene total is 14s, leaving ~4.5s of "everything
    // visible" hold time for re-reading.
    const timers = [
      setTimeout(() => setPhase(1), 300),    // Phone frame slides in
      setTimeout(() => setPhase(2), 1800),   // Heading
      setTimeout(() => setPhase(3), 3500),   // Step 1
      setTimeout(() => setPhase(4), 5500),   // Step 2
      setTimeout(() => setPhase(5), 7500),   // Step 3
      setTimeout(() => setPhase(6), 9500),   // Measurement chips
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const steps = [
    { Icon: Camera, num: 1, text: 'Open Penn Fit and tap Start Fitting Process.' },
    { Icon: ScanFace, num: 2, text: 'Frame your face inside the oval — a 3-second timer takes the photo.' },
    { Icon: Ruler, num: 3, text: 'On-device AI extracts 5 facial measurements in millimeters.' },
  ];

  const measurementChips = [
    { label: 'Nose Width', value: '35.2 mm' },
    { label: 'Nose Height', value: '48.7 mm' },
    { label: 'Nose → Chin', value: '62.3 mm' },
    { label: 'Mouth Width', value: '52.1 mm' },
    { label: 'Cheek Width', value: '138.4 mm' },
  ];

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center"
      initial={{ clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ clipPath: 'circle(150% at 50% 50%)' }}
      exit={{ opacity: 0, scale: 1.05 }}
      transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="w-full max-w-6xl px-5 sm:px-8 lg:px-12 grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-3 sm:gap-8 lg:gap-16 items-center">

        {/* LEFT: Real phone-frame screenshot of the home page */}
        <motion.div
          className="relative mx-auto"
          initial={{ opacity: 0, y: 40, rotateY: -12 }}
          animate={
            phase >= 1
              ? { opacity: 1, y: 0, rotateY: 0 }
              : { opacity: 0, y: 40, rotateY: -12 }
          }
          transition={{ type: 'spring', stiffness: 130, damping: 18 }}
          style={{ transformPerspective: 1200 }}
        >
          {/* Phone bezel */}
          <div className="relative rounded-[2.5rem] lg:rounded-[3rem] bg-[#1F3A5C] p-2 sm:p-2.5 shadow-2xl">
            <div className="relative overflow-hidden rounded-[2rem] lg:rounded-[2.5rem] bg-white w-[120px] sm:w-[200px] lg:w-[260px] aspect-[390/844]">
              <img
                src={homeScreenshot}
                alt="Penn Fit home screen"
                className="absolute inset-0 w-full h-full object-cover object-top"
                draggable={false}
              />
              {/* Soft top bezel notch */}
              <div className="absolute top-2 left-1/2 -translate-x-1/2 w-16 h-1.5 rounded-full bg-[#1F3A5C]/80" />
            </div>
          </div>
          {/* Glow halo */}
          <div className="absolute -inset-6 -z-10 rounded-[3rem] bg-[#F4B942]/20 blur-3xl" />
        </motion.div>

        {/* RIGHT: Numbered steps */}
        <div className="space-y-3 sm:space-y-5 lg:space-y-7 text-center lg:text-left">
          <div>
            <motion.h2
              className="text-[#F4B942] font-bold tracking-wider uppercase text-xs sm:text-sm mb-2"
              initial={{ opacity: 0, x: -20 }}
              animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
            >
              Steps 1 – 3 · Capture &amp; Measure
            </motion.h2>
            <motion.h3
              className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#1F3A5C] leading-[1.05] tracking-tight"
              style={{ fontFamily: 'var(--font-display)' }}
              initial={{ opacity: 0, y: 20 }}
              animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.6 }}
            >
              Take one photo.
            </motion.h3>
          </div>

          <div className="space-y-1.5 sm:space-y-3 lg:space-y-4">
            {steps.map((s, i) => {
              const { Icon } = s;
              return (
                <motion.div
                  key={s.num}
                  className="flex items-start gap-2 sm:gap-3 lg:gap-4 text-left max-w-md mx-auto lg:mx-0"
                  initial={{ opacity: 0, y: 20 }}
                  animate={phase >= 3 + i ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
                  transition={{ duration: 0.5 }}
                >
                  <div className="w-7 h-7 sm:w-9 sm:h-9 lg:w-10 lg:h-10 rounded-xl bg-[#1F3A5C]/8 border border-[#1F3A5C]/15 flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4 lg:w-5 lg:h-5 text-[#1F3A5C]" strokeWidth={2.2} />
                  </div>
                  <p className="text-xs sm:text-base lg:text-xl text-[#475569] leading-snug sm:leading-relaxed">
                    <span className="font-semibold text-[#1F3A5C]">Step {s.num}.</span> {s.text}
                  </p>
                </motion.div>
              );
            })}
          </div>

          {/* Measurement chips reveal */}
          <motion.div
            className="pt-2 sm:pt-3"
            initial={{ opacity: 0, y: 12 }}
            animate={phase >= 6 ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
            transition={{ duration: 0.6 }}
          >
            <p className="text-[11px] sm:text-xs uppercase tracking-[0.18em] text-[#1F3A5C]/60 mb-2 font-semibold">
              Extracted measurements
            </p>
            <div className="flex flex-wrap gap-1.5 sm:gap-2 justify-center lg:justify-start max-w-md mx-auto lg:mx-0">
              {measurementChips.map((c, i) => (
                <motion.span
                  key={c.label}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-[#1F3A5C]/15 text-[11px] sm:text-xs font-medium text-[#1F3A5C] shadow-sm"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={phase >= 6 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
                  transition={{ delay: i * 0.08, type: 'spring', stiffness: 220, damping: 18 }}
                >
                  <span className="text-[#475569]">{c.label}</span>
                  <span className="font-bold text-[#1F3A5C]">{c.value}</span>
                </motion.span>
              ))}
            </div>
          </motion.div>
        </div>

      </div>
    </motion.div>
  );
}

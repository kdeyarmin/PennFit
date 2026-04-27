import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ClipboardList, Sparkles, ShieldCheck } from 'lucide-react';

const questionnaireScreenshot = `${import.meta.env.BASE_URL}screenshots/questionnaire-mobile.jpg`;
const resultsScreenshot = `${import.meta.env.BASE_URL}screenshots/results-mobile.jpg`;

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    // Two-act scene: first half ~7s on the questionnaire (so the bullets
    // have time to register), second half ~9s on the results, with a soft
    // cross-fade between the phone screenshots. Scene total: 16s.
    const timers = [
      setTimeout(() => setPhase(1), 300),     // Questionnaire phone slides in
      setTimeout(() => setPhase(2), 1800),    // Heading + subhead
      setTimeout(() => setPhase(3), 3500),    // Question bullets
      setTimeout(() => setPhase(4), 7500),    // Cross-fade to results phone
      setTimeout(() => setPhase(5), 9500),    // "Top 3 mask matches" heading
      setTimeout(() => setPhase(6), 11500),   // Confidence chips reveal
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const showingResults = phase >= 4;

  const questionTopics = [
    'Sleep position & breathing pattern',
    'Facial hair, glasses, claustrophobia',
    'Prescribed CPAP pressure',
    'Skin & silicone sensitivity',
  ];

  const recommendations = [
    { name: 'AirFit F20', score: 96 },
    { name: 'AirFit P10', score: 91 },
    { name: 'DreamWear Nasal', score: 87 },
  ];

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center"
      initial={{ opacity: 0, filter: 'blur(20px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      exit={{ y: '-100%', opacity: 0 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="w-full max-w-6xl px-5 sm:px-8 lg:px-12 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3 sm:gap-8 lg:gap-16 items-center">

        {/* LEFT: Text — swaps headline + body when results take over */}
        <div className="space-y-3 sm:space-y-5 lg:space-y-7 text-center lg:text-left order-2 lg:order-1">
          <div>
            <motion.h2
              className="text-[#F4B942] font-bold tracking-wider uppercase text-xs sm:text-sm mb-2"
              initial={{ opacity: 0, x: -20 }}
              animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
            >
              {showingResults ? 'Step 5 · Your Recommendations' : 'Step 4 · Quick Questionnaire'}
            </motion.h2>
            <AnimatePresence mode="wait">
              <motion.h3
                key={showingResults ? 'results' : 'questionnaire'}
                className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#1F3A5C] leading-[1.05] tracking-tight"
                style={{ fontFamily: 'var(--font-display)' }}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.5 }}
              >
                {showingResults ? 'Your top 3 mask matches.' : '11 quick clinical questions.'}
              </motion.h3>
            </AnimatePresence>
          </div>

          {/* Questionnaire body */}
          {!showingResults && (
            <motion.div
              className="space-y-2 sm:space-y-3 lg:space-y-4 max-w-md mx-auto lg:mx-0"
              initial={{ opacity: 0, y: 16 }}
              animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
              transition={{ duration: 0.5 }}
            >
              <p className="hidden sm:block text-base sm:text-lg lg:text-xl text-[#475569] leading-snug sm:leading-relaxed text-left">
                Answer questions about how you sleep and what your CPAP setup looks like. Each one
                takes seconds — and <span className="font-semibold text-[#1F3A5C]">"I'm not sure" is a valid answer</span>.
              </p>
              <ul className="space-y-1 sm:space-y-1.5 text-left">
                {questionTopics.map((topic, i) => (
                  <motion.li
                    key={topic}
                    className="flex items-start gap-2 text-xs sm:text-sm lg:text-base text-[#475569]"
                    initial={{ opacity: 0, x: -10 }}
                    animate={phase >= 3 ? { opacity: 1, x: 0 } : { opacity: 0, x: -10 }}
                    transition={{ delay: 0.1 + i * 0.12 }}
                  >
                    <ClipboardList className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#F4B942] mt-0.5 shrink-0" strokeWidth={2.4} />
                    <span>{topic}</span>
                  </motion.li>
                ))}
              </ul>
            </motion.div>
          )}

          {/* Results body */}
          {showingResults && (
            <motion.div
              className="space-y-2 sm:space-y-3 lg:space-y-4 max-w-md mx-auto lg:mx-0"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <p className="hidden sm:block text-base sm:text-lg lg:text-xl text-[#475569] leading-snug sm:leading-relaxed text-left">
                Penn Fit ranks every mask in our catalog against your measurements and answers, then
                surfaces the three best fits with a confidence score for each.
              </p>
              <div className="space-y-1.5 sm:space-y-2">
                {recommendations.map((r, i) => (
                  <motion.div
                    key={r.name}
                    className="flex items-center justify-between gap-2 sm:gap-3 px-2.5 py-1.5 sm:px-3.5 sm:py-2.5 rounded-xl bg-white border border-[#1F3A5C]/12 shadow-sm"
                    initial={{ opacity: 0, x: -16 }}
                    animate={phase >= 6 ? { opacity: 1, x: 0 } : { opacity: 0, x: -16 }}
                    transition={{ delay: 0.1 + i * 0.12, type: 'spring', stiffness: 180, damping: 22 }}
                  >
                    <span className="text-xs sm:text-sm lg:text-base font-semibold text-[#1F3A5C]">
                      #{i + 1} · {r.name}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] sm:text-xs lg:text-sm font-bold text-[#F4B942]">
                      <Sparkles className="w-3 h-3 sm:w-3.5 sm:h-3.5" /> {r.score}%
                    </span>
                  </motion.div>
                ))}
              </div>
              <motion.p
                className="hidden sm:flex items-center gap-1.5 text-xs sm:text-sm text-[#1F3A5C]/70 font-medium pt-1"
                initial={{ opacity: 0 }}
                animate={phase >= 6 ? { opacity: 1 } : { opacity: 0 }}
                transition={{ delay: 0.5 }}
              >
                <ShieldCheck className="w-4 h-4 text-[#F4B942]" />
                Order direct from Penn Home Medical Supply.
              </motion.p>
            </motion.div>
          )}
        </div>

        {/* RIGHT (mobile: TOP): Phone frame — cross-fade between two real screenshots */}
        <motion.div
          className="relative mx-auto order-1 lg:order-2"
          initial={{ opacity: 0, y: 40, rotateY: 12 }}
          animate={
            phase >= 1
              ? { opacity: 1, y: 0, rotateY: 0 }
              : { opacity: 0, y: 40, rotateY: 12 }
          }
          transition={{ type: 'spring', stiffness: 130, damping: 18 }}
          style={{ transformPerspective: 1200 }}
        >
          <div className="relative rounded-[2.5rem] lg:rounded-[3rem] bg-[#1F3A5C] p-2 sm:p-2.5 shadow-2xl">
            <div className="relative overflow-hidden rounded-[2rem] lg:rounded-[2.5rem] bg-white w-[120px] sm:w-[200px] lg:w-[260px] aspect-[390/844]">
              <AnimatePresence mode="sync">
                <motion.img
                  key={showingResults ? 'results' : 'questionnaire'}
                  src={showingResults ? resultsScreenshot : questionnaireScreenshot}
                  alt={showingResults ? 'Recommendations screen' : 'Questionnaire screen'}
                  className="absolute inset-0 w-full h-full object-cover object-top"
                  initial={{ opacity: 0, scale: 1.04 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                  draggable={false}
                />
              </AnimatePresence>
              <div className="absolute top-2 left-1/2 -translate-x-1/2 w-16 h-1.5 rounded-full bg-[#1F3A5C]/80" />
            </div>
          </div>
          <div className="absolute -inset-6 -z-10 rounded-[3rem] bg-[#F4B942]/20 blur-3xl" />
        </motion.div>

      </div>
    </motion.div>
  );
}

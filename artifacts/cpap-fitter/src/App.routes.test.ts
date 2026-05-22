// Tests for the new routes added to App.tsx in this PR.
//
// App.tsx cannot be executed or rendered in the node vitest environment —
// it imports dozens of lazy-loaded pages and React-specific bootstrapping.
// We use static source analysis instead: readFileSync + structural assertions
// confirm that every new route and its corresponding lazy import are wired
// exactly as intended.
//
// Routes verified here (all new in this PR):
//
//   Brand pages
//     /cpap-masks              → CpapMasks
//     /cpap-masks/react-health → CpapMasksReactHealth
//     /cpap-masks/resmed       → CpapMasksResmed
//     /cpap-masks/fisher-paykel → CpapMasksFisherPaykel
//
//   Educational long-form articles
//     /learn/sleep-apnea-explained  → LearnSleepApneaExplained
//     /learn/health-risks           → LearnHealthRisks
//     /learn/pap-therapy-benefits   → LearnPapTherapyBenefits
//     /learn/how-pap-works          → LearnHowPapWorks
//     /learn/therapy-types          → LearnTherapyTypes
//     /learn/sleep-apnea-heart-health → LearnSleepApneaHeartHealth

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "App.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Brand page routes — /cpap-masks/*
// ---------------------------------------------------------------------------

describe("App.tsx — /cpap-masks route", () => {
  it('registers a <Route path="/cpap-masks" />', () => {
    expect(SRC).toContain('path="/cpap-masks"');
  });

  it("maps /cpap-masks to the CpapMasks component", () => {
    expect(SRC).toContain('path="/cpap-masks" component={CpapMasks}');
  });

  it("lazy-imports CpapMasks from @/pages/cpap-masks", () => {
    expect(SRC).toContain("import(\"@/pages/cpap-masks\")");
  });

  it("extracts CpapMasks as the named export from the module", () => {
    expect(SRC).toContain("m.CpapMasks");
  });
});

describe("App.tsx — /cpap-masks/react-health route", () => {
  it('registers a <Route path="/cpap-masks/react-health" />', () => {
    expect(SRC).toContain('path="/cpap-masks/react-health"');
  });

  it("maps /cpap-masks/react-health to CpapMasksReactHealth", () => {
    expect(SRC).toContain("component={CpapMasksReactHealth}");
  });

  it("lazy-imports CpapMasksReactHealth from @/pages/cpap-masks-react-health", () => {
    expect(SRC).toContain("import(\"@/pages/cpap-masks-react-health\")");
  });

  it("extracts CpapMasksReactHealth as the named export", () => {
    expect(SRC).toContain("m.CpapMasksReactHealth");
  });
});

describe("App.tsx — /cpap-masks/resmed route", () => {
  it('registers a <Route path="/cpap-masks/resmed" />', () => {
    expect(SRC).toContain('path="/cpap-masks/resmed"');
  });

  it("maps /cpap-masks/resmed to CpapMasksResmed", () => {
    expect(SRC).toContain("component={CpapMasksResmed}");
  });

  it("lazy-imports CpapMasksResmed from @/pages/cpap-masks-resmed", () => {
    expect(SRC).toContain("import(\"@/pages/cpap-masks-resmed\")");
  });

  it("extracts CpapMasksResmed as the named export", () => {
    expect(SRC).toContain("m.CpapMasksResmed");
  });
});

describe("App.tsx — /cpap-masks/fisher-paykel route", () => {
  it('registers a <Route path="/cpap-masks/fisher-paykel" />', () => {
    expect(SRC).toContain('path="/cpap-masks/fisher-paykel"');
  });

  it("maps /cpap-masks/fisher-paykel to CpapMasksFisherPaykel", () => {
    expect(SRC).toContain("component={CpapMasksFisherPaykel}");
  });

  it("lazy-imports CpapMasksFisherPaykel from @/pages/cpap-masks-fisher-paykel", () => {
    expect(SRC).toContain("import(\"@/pages/cpap-masks-fisher-paykel\")");
  });

  it("extracts CpapMasksFisherPaykel as the named export", () => {
    expect(SRC).toContain("m.CpapMasksFisherPaykel");
  });
});

// ---------------------------------------------------------------------------
// Educational article routes — /learn/*
// ---------------------------------------------------------------------------

describe("App.tsx — /learn/sleep-apnea-explained route", () => {
  it('registers a <Route path="/learn/sleep-apnea-explained" />', () => {
    expect(SRC).toContain('path="/learn/sleep-apnea-explained"');
  });

  it("maps to the LearnSleepApneaExplained component", () => {
    expect(SRC).toContain("component={LearnSleepApneaExplained}");
  });

  it("lazy-imports from @/pages/learn-sleep-apnea-explained", () => {
    expect(SRC).toContain("import(\"@/pages/learn-sleep-apnea-explained\")");
  });

  it("extracts LearnSleepApneaExplained as the named export", () => {
    expect(SRC).toContain("m.LearnSleepApneaExplained");
  });
});

describe("App.tsx — /learn/health-risks route", () => {
  it('registers a <Route path="/learn/health-risks" />', () => {
    expect(SRC).toContain('path="/learn/health-risks"');
  });

  it("maps to the LearnHealthRisks component", () => {
    expect(SRC).toContain("component={LearnHealthRisks}");
  });

  it("lazy-imports from @/pages/learn-health-risks", () => {
    expect(SRC).toContain("import(\"@/pages/learn-health-risks\")");
  });

  it("extracts LearnHealthRisks as the named export", () => {
    expect(SRC).toContain("m.LearnHealthRisks");
  });
});

describe("App.tsx — /learn/pap-therapy-benefits route", () => {
  it('registers a <Route path="/learn/pap-therapy-benefits" />', () => {
    expect(SRC).toContain('path="/learn/pap-therapy-benefits"');
  });

  it("maps to the LearnPapTherapyBenefits component", () => {
    expect(SRC).toContain("component={LearnPapTherapyBenefits}");
  });

  it("lazy-imports from @/pages/learn-pap-therapy-benefits", () => {
    expect(SRC).toContain("import(\"@/pages/learn-pap-therapy-benefits\")");
  });

  it("extracts LearnPapTherapyBenefits as the named export", () => {
    expect(SRC).toContain("m.LearnPapTherapyBenefits");
  });
});

describe("App.tsx — /learn/how-pap-works route", () => {
  it('registers a <Route path="/learn/how-pap-works" />', () => {
    expect(SRC).toContain('path="/learn/how-pap-works"');
  });

  it("maps to the LearnHowPapWorks component", () => {
    expect(SRC).toContain("component={LearnHowPapWorks}");
  });

  it("lazy-imports from @/pages/learn-how-pap-works", () => {
    expect(SRC).toContain("import(\"@/pages/learn-how-pap-works\")");
  });

  it("extracts LearnHowPapWorks as the named export", () => {
    expect(SRC).toContain("m.LearnHowPapWorks");
  });
});

describe("App.tsx — /learn/therapy-types route", () => {
  it('registers a <Route path="/learn/therapy-types" />', () => {
    expect(SRC).toContain('path="/learn/therapy-types"');
  });

  it("maps to the LearnTherapyTypes component", () => {
    expect(SRC).toContain("component={LearnTherapyTypes}");
  });

  it("lazy-imports from @/pages/learn-therapy-types", () => {
    expect(SRC).toContain("import(\"@/pages/learn-therapy-types\")");
  });

  it("extracts LearnTherapyTypes as the named export", () => {
    expect(SRC).toContain("m.LearnTherapyTypes");
  });
});

describe("App.tsx — /learn/sleep-apnea-heart-health route", () => {
  it('registers a <Route path="/learn/sleep-apnea-heart-health" />', () => {
    expect(SRC).toContain('path="/learn/sleep-apnea-heart-health"');
  });

  it("maps to the LearnSleepApneaHeartHealth component", () => {
    expect(SRC).toContain("component={LearnSleepApneaHeartHealth}");
  });

  it("lazy-imports from @/pages/learn-sleep-apnea-heart-health", () => {
    expect(SRC).toContain("import(\"@/pages/learn-sleep-apnea-heart-health\")");
  });

  it("extracts LearnSleepApneaHeartHealth as the named export", () => {
    expect(SRC).toContain("m.LearnSleepApneaHeartHealth");
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: all new brand + learn routes are lazy-loaded
// ---------------------------------------------------------------------------

describe("App.tsx — new routes are lazy-loaded (not in the initial bundle)", () => {
  it("declares CpapMasks with React.lazy / lazy()", () => {
    expect(SRC).toMatch(/const CpapMasks\s*=\s*lazy\(/);
  });

  it("declares CpapMasksReactHealth with lazy()", () => {
    expect(SRC).toMatch(/const CpapMasksReactHealth\s*=\s*lazy\(/);
  });

  it("declares CpapMasksResmed with lazy()", () => {
    expect(SRC).toMatch(/const CpapMasksResmed\s*=\s*lazy\(/);
  });

  it("declares CpapMasksFisherPaykel with lazy()", () => {
    expect(SRC).toMatch(/const CpapMasksFisherPaykel\s*=\s*lazy\(/);
  });

  it("declares LearnHealthRisks with lazy()", () => {
    expect(SRC).toMatch(/const LearnHealthRisks\s*=\s*lazy\(/);
  });

  it("declares LearnHowPapWorks with lazy()", () => {
    expect(SRC).toMatch(/const LearnHowPapWorks\s*=\s*lazy\(/);
  });

  it("declares LearnSleepApneaHeartHealth with lazy()", () => {
    expect(SRC).toMatch(/const LearnSleepApneaHeartHealth\s*=\s*lazy\(/);
  });
});

// ---------------------------------------------------------------------------
// Route ordering — cpap-masks routes appear together in PatientRouter
// ---------------------------------------------------------------------------

describe("App.tsx — cpap-mask routes are grouped together", () => {
  it("registers /cpap-masks before /cpap-masks/react-health in source order", () => {
    const base = SRC.indexOf('path="/cpap-masks"');
    const sub = SRC.indexOf('path="/cpap-masks/react-health"');
    expect(base).toBeGreaterThan(-1);
    expect(sub).toBeGreaterThan(-1);
    expect(base).toBeLessThan(sub);
  });

  it("registers /cpap-masks/react-health before /cpap-masks/resmed", () => {
    const rh = SRC.indexOf('path="/cpap-masks/react-health"');
    const rm = SRC.indexOf('path="/cpap-masks/resmed"');
    expect(rh).toBeLessThan(rm);
  });

  it("registers /cpap-masks/resmed before /cpap-masks/fisher-paykel", () => {
    const rm = SRC.indexOf('path="/cpap-masks/resmed"');
    const fp = SRC.indexOf('path="/cpap-masks/fisher-paykel"');
    expect(rm).toBeLessThan(fp);
  });
});
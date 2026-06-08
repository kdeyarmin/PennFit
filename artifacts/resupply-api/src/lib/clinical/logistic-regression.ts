// Logistic-regression trainer + evaluator (RT #R7, ML harness).
//
// Pure, dependency-free. The offline adherence-model harness uses this to
// (1) standardize features, (2) fit weights by batch gradient descent,
// (3) evaluate (accuracy / precision / recall / AUC), and (4) score new
// feature vectors. NO model is shipped — this is the plumbing a future
// trained model rides on; the live predictor stays heuristic until a
// model is fit on enough real data and deliberately swapped in.

export interface TrainingSample {
  x: number[];
  y: 0 | 1;
}

export interface LogisticModel {
  /** Per-feature weights (in the caller's feature order). */
  weights: number[];
  bias: number;
  /** Standardization params captured at fit time (applied at score time). */
  featureMeans: number[];
  featureStds: number[];
  /** Provenance for the model file. */
  trainedAt: string;
  sampleCount: number;
}

export interface TrainOptions {
  iterations?: number;
  learningRate?: number;
  /** L2 regularization strength. */
  l2?: number;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function standardizeParams(rows: number[][]): {
  means: number[];
  stds: number[];
} {
  const dim = rows[0]?.length ?? 0;
  const means = new Array(dim).fill(0);
  const stds = new Array(dim).fill(1);
  if (rows.length === 0) return { means, stds };
  for (let j = 0; j < dim; j++) {
    let m = 0;
    for (const r of rows) m += r[j]!;
    m /= rows.length;
    means[j] = m;
    let v = 0;
    for (const r of rows) v += (r[j]! - m) ** 2;
    v /= rows.length;
    // Guard against a zero-variance feature (constant column).
    stds[j] = Math.sqrt(v) || 1;
  }
  return { means, stds };
}

function applyStandardize(
  x: number[],
  means: number[],
  stds: number[],
): number[] {
  return x.map((v, j) => (v - (means[j] ?? 0)) / (stds[j] ?? 1));
}

/**
 * Fit a logistic-regression model by batch gradient descent on
 * standardized features. Pure (deterministic for given inputs).
 */
export function trainLogisticRegression(
  samples: readonly TrainingSample[],
  opts: TrainOptions = {},
): LogisticModel {
  const iterations = opts.iterations ?? 500;
  const lr = opts.learningRate ?? 0.1;
  const l2 = opts.l2 ?? 0.0;
  const dim = samples[0]?.x.length ?? 0;
  const rawX = samples.map((s) => s.x);
  const { means, stds } = standardizeParams(rawX);
  const X = rawX.map((x) => applyStandardize(x, means, stds));
  const y = samples.map((s) => s.y);
  const n = samples.length;

  const weights = new Array(dim).fill(0);
  let bias = 0;
  for (let iter = 0; iter < iterations && n > 0; iter++) {
    const gradW = new Array(dim).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      let z = bias;
      for (let j = 0; j < dim; j++) z += weights[j]! * xi[j]!;
      const err = sigmoid(z) - y[i]!;
      for (let j = 0; j < dim; j++) gradW[j]! += err * xi[j]!;
      gradB += err;
    }
    for (let j = 0; j < dim; j++) {
      weights[j]! -= lr * (gradW[j]! / n + l2 * weights[j]!);
    }
    bias -= lr * (gradB / n);
  }

  return {
    weights,
    bias,
    featureMeans: means,
    featureStds: stds,
    trainedAt: new Date().toISOString(),
    sampleCount: n,
  };
}

/** Predict P(compliant) for a raw (un-standardized) feature vector. Pure. */
export function predictProbability(model: LogisticModel, x: number[]): number {
  const xs = applyStandardize(x, model.featureMeans, model.featureStds);
  let z = model.bias;
  for (let j = 0; j < model.weights.length; j++) {
    z += model.weights[j]! * (xs[j] ?? 0);
  }
  return sigmoid(z);
}

export interface EvalMetrics {
  n: number;
  accuracy: number;
  precision: number;
  recall: number;
  /** Area under the ROC curve (rank-based; 0.5 = random). */
  auc: number;
}

/**
 * Evaluate a model against labeled samples at a 0.5 decision threshold,
 * plus a rank-based AUC. Pure.
 */
export function evaluate(
  model: LogisticModel,
  samples: readonly TrainingSample[],
): EvalMetrics {
  const n = samples.length;
  if (n === 0) {
    return { n: 0, accuracy: 0, precision: 0, recall: 0, auc: 0.5 };
  }
  const scored = samples.map((s) => ({
    p: predictProbability(model, s.x),
    y: s.y,
  }));
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const { p, y } of scored) {
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === 1 && y === 1) tp++;
    else if (pred === 1 && y === 0) fp++;
    else if (pred === 0 && y === 0) tn++;
    else fn++;
  }
  return {
    n,
    accuracy: (tp + tn) / n,
    precision: tp + fp === 0 ? 0 : tp / (tp + fp),
    recall: tp + fn === 0 ? 0 : tp / (tp + fn),
    auc: rankAuc(scored),
  };
}

/** Rank-based AUC (Mann–Whitney U). Pure. */
function rankAuc(scored: ReadonlyArray<{ p: number; y: 0 | 1 }>): number {
  const pos = scored.filter((s) => s.y === 1);
  const neg = scored.filter((s) => s.y === 0);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  // Sort by score, assign average ranks (ties → mid-rank).
  const sorted = [...scored].sort((a, b) => a.p - b.p);
  const ranks = new Map<number, number>();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j]!.p === sorted[i]!.p) j++;
    const avgRank = (i + 1 + j) / 2; // 1-based average of the tie block
    for (let k = i; k < j; k++) ranks.set(k, avgRank);
    i = j;
  }
  // Sum of ranks of positives.
  let sumPosRanks = 0;
  for (let k = 0; k < sorted.length; k++) {
    if (sorted[k]!.y === 1) sumPosRanks += ranks.get(k)!;
  }
  const nPos = pos.length;
  const nNeg = neg.length;
  return (sumPosRanks - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

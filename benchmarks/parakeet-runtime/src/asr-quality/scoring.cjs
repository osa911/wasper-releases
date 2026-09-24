const { normalizeTranscript } = require('./normalization.cjs');

const CANONICAL_SCORE_PROOFS = new WeakMap();
const MAX_SCORING_INPUT_CODE_POINTS = 40_000;
const MAX_EDIT_UNITS_PER_SIDE = 20_000;
const BIT_PARALLEL_THRESHOLD_CELLS = 100_000_000;
const MAX_EDIT_MATRIX_CELLS = 300_000_000;
const MAX_MANIFEST_REFERENCE_UNITS = 10_000;
const BIT_PARALLEL_TRACE_BLOCK_COLUMNS = 128;

class ScoringBudgetError extends RangeError {
  constructor(message) {
    super(message);
    this.name = 'RangeError';
    this.code = 'ASR_SCORING_BUDGET_EXCEEDED';
  }
}

function assertTokenArray(tokens, name) {
  if (!Array.isArray(tokens)) {
    throw new TypeError(`${name} must be an array of string tokens`);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (typeof tokens[index] !== 'string') {
      throw new TypeError(`${name} must be an array of string tokens`);
    }
  }
}

function bitParallelContext(referenceTokens) {
  const equality = new Map();
  for (let index = 0; index < referenceTokens.length; index += 1) {
    const bit = 1n << BigInt(index);
    const token = referenceTokens[index];
    equality.set(token, (equality.get(token) ?? 0n) | bit);
  }
  const mask = (1n << BigInt(referenceTokens.length)) - 1n;
  return {
    equality,
    finalBit: 1n << BigInt(referenceTokens.length - 1),
    mask,
  };
}

function advanceBitParallel(state, token, context) {
  const equal = context.equality.get(token) ?? 0n;
  const vertical = equal | state.negative;
  const horizontal = (((equal & state.positive) + state.positive) ^ state.positive) | equal;
  const positiveHorizontal = state.negative | ~(horizontal | state.positive);
  const negativeHorizontal = state.positive & horizontal;
  let distance = state.distance;
  if ((positiveHorizontal & context.finalBit) !== 0n) distance += 1;
  if ((negativeHorizontal & context.finalBit) !== 0n) distance -= 1;
  const shiftedPositiveHorizontal = ((positiveHorizontal << 1n) | 1n) & context.mask;
  const shiftedNegativeHorizontal = (negativeHorizontal << 1n) & context.mask;
  return {
    distance,
    negative: shiftedPositiveHorizontal & vertical,
    negativeHorizontal: negativeHorizontal & context.mask,
    positive: (shiftedNegativeHorizontal | ~(vertical | shiftedPositiveHorizontal)) & context.mask,
    positiveHorizontal: positiveHorizontal & context.mask,
  };
}

function initialBitParallelState(referenceLength, mask) {
  return {
    distance: referenceLength,
    negative: 0n,
    positive: mask,
  };
}

function bitParallelDistance(referenceTokens, hypothesisTokens) {
  if (referenceTokens.length === 0) return hypothesisTokens.length;
  const context = bitParallelContext(referenceTokens);
  let state = initialBitParallelState(referenceTokens.length, context.mask);
  for (const token of hypothesisTokens) {
    state = advanceBitParallel(state, token, context);
  }
  return state.distance;
}

function verticalDifference(state, referenceIndex) {
  if (referenceIndex === 0) return 0;
  const bit = 1n << BigInt(referenceIndex - 1);
  if ((state.positive & bit) !== 0n) return 1;
  if ((state.negative & bit) !== 0n) return -1;
  return 0;
}

function horizontalDifference(transition, referenceIndex) {
  if (referenceIndex === 0) return 1;
  const bit = 1n << BigInt(referenceIndex - 1);
  if ((transition.positiveHorizontal & bit) !== 0n) return 1;
  if ((transition.negativeHorizontal & bit) !== 0n) return -1;
  return 0;
}

function bitParallelEditCounts(referenceTokens, hypothesisTokens) {
  if (referenceTokens.length === 0) {
    return {
      substitutions: 0,
      deletions: 0,
      insertions: hypothesisTokens.length,
      referenceUnits: 0,
      errors: hypothesisTokens.length,
    };
  }

  const context = bitParallelContext(referenceTokens);
  const checkpoints = new Map();
  let state = initialBitParallelState(referenceTokens.length, context.mask);
  checkpoints.set(0, state);
  for (let column = 1; column <= hypothesisTokens.length; column += 1) {
    state = advanceBitParallel(state, hypothesisTokens[column - 1], context);
    if (column % BIT_PARALLEL_TRACE_BLOCK_COLUMNS === 0) checkpoints.set(column, state);
  }

  const errors = state.distance;
  let referenceIndex = referenceTokens.length;
  let hypothesisIndex = hypothesisTokens.length;
  let currentCost = errors;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;

  while (hypothesisIndex > 0) {
    const blockStart =
      Math.floor((hypothesisIndex - 1) / BIT_PARALLEL_TRACE_BLOCK_COLUMNS) *
      BIT_PARALLEL_TRACE_BLOCK_COLUMNS;
    let blockState = checkpoints.get(blockStart);
    const states = [blockState];
    const transitions = [null];
    for (let column = blockStart + 1; column <= hypothesisIndex; column += 1) {
      const transition = advanceBitParallel(blockState, hypothesisTokens[column - 1], context);
      transitions.push(transition);
      blockState = transition;
      states.push(blockState);
    }

    while (hypothesisIndex > blockStart) {
      if (referenceIndex === 0) {
        insertions += hypothesisIndex;
        currentCost -= hypothesisIndex;
        hypothesisIndex = 0;
        break;
      }

      const localColumn = hypothesisIndex - blockStart;
      const currentState = states[localColumn];
      const transition = transitions[localColumn];
      const insertionPredecessorCost =
        currentCost - horizontalDifference(transition, referenceIndex);
      const diagonalPredecessorCost =
        insertionPredecessorCost - verticalDifference(states[localColumn - 1], referenceIndex);

      if (referenceTokens[referenceIndex - 1] === hypothesisTokens[hypothesisIndex - 1]) {
        currentCost = diagonalPredecessorCost;
        referenceIndex -= 1;
        hypothesisIndex -= 1;
        continue;
      }

      const deletionPredecessorCost =
        currentCost - verticalDifference(currentState, referenceIndex);
      const substitutionCost = diagonalPredecessorCost + 1;
      const deletionCost = deletionPredecessorCost + 1;
      const insertionCost = insertionPredecessorCost + 1;
      if (deletionCost < substitutionCost && deletionCost <= insertionCost) {
        currentCost = deletionPredecessorCost;
        deletions += 1;
        referenceIndex -= 1;
      } else if (insertionCost < substitutionCost && insertionCost < deletionCost) {
        currentCost = insertionPredecessorCost;
        insertions += 1;
        hypothesisIndex -= 1;
      } else {
        currentCost = diagonalPredecessorCost;
        substitutions += 1;
        referenceIndex -= 1;
        hypothesisIndex -= 1;
      }
    }
  }

  deletions += referenceIndex;
  currentCost -= referenceIndex;
  if (currentCost !== 0 || substitutions + deletions + insertions !== errors) {
    throw new Error('ASR bit-parallel alignment traceback did not reach the matrix origin');
  }
  return {
    substitutions,
    deletions,
    insertions,
    referenceUnits: referenceTokens.length,
    errors,
  };
}

function editCounts(referenceTokens, hypothesisTokens) {
  assertTokenArray(referenceTokens, 'referenceTokens');
  assertTokenArray(hypothesisTokens, 'hypothesisTokens');
  if (
    referenceTokens.length > MAX_EDIT_UNITS_PER_SIDE ||
    hypothesisTokens.length > MAX_EDIT_UNITS_PER_SIDE
  ) {
    throw new ScoringBudgetError(
      `ASR scoring unit budget exceeded: each side is limited to ${MAX_EDIT_UNITS_PER_SIDE} units`
    );
  }
  const logicalCells = referenceTokens.length * hypothesisTokens.length;
  if (logicalCells > MAX_EDIT_MATRIX_CELLS) {
    throw new ScoringBudgetError(
      `ASR scoring matrix budget exceeded: each alignment is limited to ${MAX_EDIT_MATRIX_CELLS} logical cells`
    );
  }
  if (logicalCells >= BIT_PARALLEL_THRESHOLD_CELLS) {
    return bitParallelEditCounts(referenceTokens, hypothesisTokens);
  }

  const columns = hypothesisTokens.length + 1;
  let previousCost = new Uint32Array(columns);
  let previousSubstitutions = new Uint32Array(columns);
  let previousDeletions = new Uint32Array(columns);
  let previousInsertions = new Uint32Array(columns);
  let currentCost = new Uint32Array(columns);
  let currentSubstitutions = new Uint32Array(columns);
  let currentDeletions = new Uint32Array(columns);
  let currentInsertions = new Uint32Array(columns);
  for (let index = 1; index < columns; index += 1) {
    previousCost[index] = index;
    previousInsertions[index] = index;
  }

  for (let referenceIndex = 1; referenceIndex <= referenceTokens.length; referenceIndex += 1) {
    currentCost[0] = referenceIndex;
    currentSubstitutions[0] = 0;
    currentDeletions[0] = referenceIndex;
    currentInsertions[0] = 0;

    for (
      let hypothesisIndex = 1;
      hypothesisIndex <= hypothesisTokens.length;
      hypothesisIndex += 1
    ) {
      if (referenceTokens[referenceIndex - 1] === hypothesisTokens[hypothesisIndex - 1]) {
        const diagonal = hypothesisIndex - 1;
        currentCost[hypothesisIndex] = previousCost[diagonal];
        currentSubstitutions[hypothesisIndex] = previousSubstitutions[diagonal];
        currentDeletions[hypothesisIndex] = previousDeletions[diagonal];
        currentInsertions[hypothesisIndex] = previousInsertions[diagonal];
        continue;
      }

      const diagonal = hypothesisIndex - 1;
      const substitutionCost = previousCost[diagonal] + 1;
      const deletionCost = previousCost[hypothesisIndex] + 1;
      const insertionCost = currentCost[diagonal] + 1;
      if (deletionCost < substitutionCost && deletionCost <= insertionCost) {
        currentCost[hypothesisIndex] = deletionCost;
        currentSubstitutions[hypothesisIndex] = previousSubstitutions[hypothesisIndex];
        currentDeletions[hypothesisIndex] = previousDeletions[hypothesisIndex] + 1;
        currentInsertions[hypothesisIndex] = previousInsertions[hypothesisIndex];
      } else if (insertionCost < substitutionCost && insertionCost < deletionCost) {
        currentCost[hypothesisIndex] = insertionCost;
        currentSubstitutions[hypothesisIndex] = currentSubstitutions[diagonal];
        currentDeletions[hypothesisIndex] = currentDeletions[diagonal];
        currentInsertions[hypothesisIndex] = currentInsertions[diagonal] + 1;
      } else {
        currentCost[hypothesisIndex] = substitutionCost;
        currentSubstitutions[hypothesisIndex] = previousSubstitutions[diagonal] + 1;
        currentDeletions[hypothesisIndex] = previousDeletions[diagonal];
        currentInsertions[hypothesisIndex] = previousInsertions[diagonal];
      }
    }

    [previousCost, currentCost] = [currentCost, previousCost];
    [previousSubstitutions, currentSubstitutions] = [currentSubstitutions, previousSubstitutions];
    [previousDeletions, currentDeletions] = [currentDeletions, previousDeletions];
    [previousInsertions, currentInsertions] = [currentInsertions, previousInsertions];
  }

  const finalIndex = hypothesisTokens.length;
  const substitutions = previousSubstitutions[finalIndex];
  const deletions = previousDeletions[finalIndex];
  const insertions = previousInsertions[finalIndex];
  const errors = substitutions + deletions + insertions;
  return {
    substitutions,
    deletions,
    insertions,
    referenceUnits: referenceTokens.length,
    errors,
  };
}

function assertScoringInputBudget(value, label) {
  if (typeof value !== 'string') return;
  let codePoints = 0;
  for (const _character of value) {
    codePoints += 1;
    if (codePoints > MAX_SCORING_INPUT_CODE_POINTS) {
      throw new ScoringBudgetError(
        `${label} scoring input budget exceeded: text is limited to ${MAX_SCORING_INPUT_CODE_POINTS} Unicode code points`
      );
    }
  }
}

function rateCounts(counts) {
  return {
    ...counts,
    rate: counts.referenceUnits === 0 ? null : counts.errors / counts.referenceUnits,
  };
}

function boundedNormalizedUnits(normalized, label) {
  let wordCount = normalized === '' ? 0 : 1;
  let characterCount = 0;
  for (const character of normalized) {
    if (character === ' ') {
      wordCount += 1;
    } else {
      characterCount += 1;
    }
    if (wordCount > MAX_EDIT_UNITS_PER_SIDE || characterCount > MAX_EDIT_UNITS_PER_SIDE) {
      throw new ScoringBudgetError(
        `${label} normalized scoring unit budget exceeded: each side is limited to ${MAX_EDIT_UNITS_PER_SIDE} units`
      );
    }
  }

  const words = normalized === '' ? [] : normalized.split(' ');
  const characters = [];
  for (const character of normalized) {
    if (character !== ' ') characters.push(character);
  }
  return { words, characters };
}

function scoreTranscript(reference, hypothesis, language) {
  assertScoringInputBudget(reference, 'reference');
  assertScoringInputBudget(hypothesis, 'hypothesis');
  const normalizedReference = normalizeTranscript(reference, language);
  const referenceUnits = boundedNormalizedUnits(normalizedReference, 'reference');
  const normalizedHypothesis = normalizeTranscript(hypothesis, language);
  const hypothesisUnits = boundedNormalizedUnits(normalizedHypothesis, 'hypothesis');

  const score = {
    normalizedReference,
    normalizedHypothesis,
    wer: rateCounts(editCounts(referenceUnits.words, hypothesisUnits.words)),
    cer: rateCounts(editCounts(referenceUnits.characters, hypothesisUnits.characters)),
  };
  CANONICAL_SCORE_PROOFS.set(score, {
    reference,
    hypothesis,
    language,
    snapshot: JSON.stringify(score),
  });
  return score;
}

function assertCanonicalScore(score, reference, hypothesis, language) {
  const proof =
    score && (typeof score === 'object' || typeof score === 'function')
      ? CANONICAL_SCORE_PROOFS.get(score)
      : null;
  if (
    !proof ||
    proof.reference !== reference ||
    proof.hypothesis !== hypothesis ||
    proof.language !== language ||
    proof.snapshot !== JSON.stringify(score)
  ) {
    throw new TypeError('ASR score must be the unmodified canonical Task 3 scorer result');
  }
}

module.exports = {
  MAX_EDIT_MATRIX_CELLS,
  MAX_EDIT_UNITS_PER_SIDE,
  MAX_MANIFEST_REFERENCE_UNITS,
  MAX_SCORING_INPUT_CODE_POINTS,
  assertCanonicalScore,
  bitParallelDistance,
  bitParallelEditCounts,
  editCounts,
  scoreTranscript,
};

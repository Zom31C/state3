/** JSON-serializable value. States Σ and patches ΔΣ are built from these. */
export type StateValue =
  string | number | boolean | null | StateValue[] | { [key: string]: StateValue };

/**
 * Execution-state dictionary Σ_t. In a patch ΔΣ a `null` value means
 * "delete this key" (paper Appendix A merge semantics).
 */
export type StateDict = { [key: string]: StateValue };

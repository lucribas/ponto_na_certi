export class BoundaryValidationError extends Error {
  override readonly name = 'BoundaryValidationError';
}

export class OperationTransitionError extends Error {
  override readonly name = 'OperationTransitionError';
}

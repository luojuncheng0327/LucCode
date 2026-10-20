interface StepIconProps {
  size?: number;
  className?: string;
}

export function ParallelStepIcon({ size = 16, className }: StepIconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2 L14 8 L8 14 L2 8 Z" fill="currentColor" />
    </svg>
  );
}

export function PipelineStepIcon({ size = 16, className }: StepIconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="currentColor" />
    </svg>
  );
}

export function LogStepIcon({ size = 16, className }: StepIconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.5 L14 13 L2 13 Z" fill="currentColor" />
    </svg>
  );
}

import type { Environment } from '@/lib/types/orderbook';

interface EnvironmentSelectorProps {
  selectedEnvironment: Environment;
  onEnvironmentChange: (env: Environment) => void;
  disabled?: boolean;
}

export default function EnvironmentSelector({
  selectedEnvironment,
  onEnvironmentChange,
  disabled = false,
}: EnvironmentSelectorProps) {
  const environments: { value: Environment; label: string }[] = [
    { value: 'staging', label: 'Staging' },
    { value: 'cronos', label: 'Cronos' },
  ];

  return (
    <div className="flex gap-2">
      {environments.map((env) => (
        <button
          key={env.value}
          type="button"
          onClick={() => onEnvironmentChange(env.value)}
          disabled={disabled}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            selectedEnvironment === env.value
              ? 'bg-blue-600 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          aria-label={`Select ${env.label} environment`}
          tabIndex={0}
        >
          {env.label}
        </button>
      ))}
    </div>
  );
}

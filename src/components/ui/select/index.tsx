interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  id?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
}

export function Select({ value, onValueChange, options, disabled, ...props }: SelectProps) {
  return (
    <div className="relative">
      <select
        {...props}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        disabled={disabled}
        className="block w-full rounded-md border border-input bg-background px-3 py-2 focus:ring-2 focus:ring-primary focus:outline-none disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

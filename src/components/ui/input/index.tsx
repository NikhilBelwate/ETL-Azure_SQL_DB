type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export function Input({ type = "text", className = "", ...props }: InputProps) {
  return (
    <input
      type={type}
      {...props}
      className={`w-full min-w-0 border border-input bg-background px-3 py-2 rounded-md focus:ring-2 focus:ring-primary placeholder:text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    />
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ disabled = false, type = "button", className, children, ...props }: ButtonProps) {
  const btnClass = `inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm font-medium transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${className || ""}`;
  
  return (
    <button
      {...props}
      type={type}
      disabled={disabled}
      className={btnClass}
    >
      {children}
    </button>
  );
}

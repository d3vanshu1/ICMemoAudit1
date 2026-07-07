import type { ButtonHTMLAttributes, ReactNode } from "react";
import ICSpinner from "./ICSpinner";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

interface ICButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  glow?: boolean;
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-ic-turquoise hover:bg-ic-turquoise/90 text-ic-dark font-bold border border-transparent shadow-md shadow-ic-turquoise/20 hover:shadow-lg hover:shadow-ic-turquoise/30",
  secondary:
    "bg-ic-surface-light hover:bg-ic-surface-light/80 text-ic-text border border-ic-border hover:border-ic-soft-gray/50",
  danger:
    "bg-ic-coral hover:bg-ic-coral/90 text-white border border-transparent shadow-md shadow-ic-coral/20",
  ghost:
    "bg-transparent hover:bg-ic-surface-light text-ic-text/80 hover:text-ic-text border border-transparent",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs rounded-lg",
  md: "px-4 py-2 text-sm rounded-lg",
  lg: "px-6 py-2.5 text-base rounded-xl",
};

export default function ICButton({
  variant = "primary",
  size = "md",
  loading = false,
  glow = false,
  disabled,
  children,
  className = "",
  ...props
}: ICButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      className={`inline-flex items-center justify-center gap-2 font-bold
        transition-all duration-200 ease-out cursor-pointer
        focus:outline-none focus:ring-2 focus:ring-ic-turquoise/50 focus:ring-offset-2 focus:ring-offset-ic-dark
        disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none
        active:scale-[0.97]
        ${variantClasses[variant]} ${sizeClasses[size]}
        ${glow && variant === "primary" ? "shadow-lg shadow-ic-turquoise/30" : ""}
        ${className}`}
      disabled={isDisabled}
      {...props}
    >
      {loading && <ICSpinner size="sm" />}
      {children}
    </button>
  );
}

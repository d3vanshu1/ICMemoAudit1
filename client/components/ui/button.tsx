/* eslint-disable react-refresh/only-export-components */
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

// Variants
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// Button Component
const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean;
    }
>(
  (
    {
      className,
      variant = "default",
      size = "default",
      asChild = false,
      ...props
    },
    ref,
  ) => {
    const Comp: React.ElementType = asChild ? Slot : "button";

    return (
      <Comp
        ref={ref}
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

type ButtonProps = React.ComponentProps<typeof Button>;
type ButtonVariantProps = VariantProps<typeof buttonVariants>;

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<ButtonProps> = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx().propertiesPanel({
      label: "Text",
    }),
  }),

  appearance: Section.category(PropsCategory.Appearance).children({
    variant: Prop.string<
      "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
    >().propertiesPanel({
      label: "Variant",
      controlType: "DROP_DOWN",
      options: [
        {
          label: "Default",
          value: "default",
        },
        {
          label: "Destructive",
          value: "destructive",
        },
        {
          label: "Outline",
          value: "outline",
        },
        {
          label: "Secondary",
          value: "secondary",
        },
        {
          label: "Ghost",
          value: "ghost",
        },
        {
          label: "Link",
          value: "link",
        },
      ],
    }),
    size: Prop.string<"default" | "sm" | "lg" | "icon">().propertiesPanel({
      label: "Size",
      controlType: "DROP_DOWN",
      options: [
        {
          label: "Default",
          value: "default",
        },
        {
          label: "Small",
          value: "sm",
        },
        {
          label: "Large",
          value: "lg",
        },
        {
          label: "Icon",
          value: "icon",
        },
      ],
    }),
  }),

  interaction: Section.category(PropsCategory.Interaction).children({
    disabled: Prop.boolean().propertiesPanel({
      label: "Disabled",
      controlType: "SWITCH",
      description: "Whether the button is disabled",
    }),
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onClick: Prop.eventHandler().propertiesPanel({
      label: "onClick",
      description: "Triggered when the button is clicked",
    }),
  }),
};

// Editor Template
// Editor Config
const editorConfig: EditorConfig = {
  icon: "button",
  useAs: {
    defaultButton: true,
  },
  isDroppable: false,
  hasExtendedClickArea: true,
};

// Register Component
registerComponent(Button, propertiesDefinition).editorConfig(editorConfig);

export { Button, buttonVariants, type ButtonVariantProps };

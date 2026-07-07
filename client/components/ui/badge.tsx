/* eslint-disable react-refresh/only-export-components */
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { IconName } from "lucide-react/dynamic";
import type * as React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { Icon as IconComponent } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// Variants
const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeVariantProps = VariantProps<typeof badgeVariants>;

// Base Badge Component
interface BaseBadgeProps
  extends React.ComponentPropsWithoutRef<"span">, BadgeVariantProps {
  asChild?: boolean;
}

function BadgeComponent({
  className,
  variant,
  asChild = false,
  ...props
}: BaseBadgeProps) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      data-slot="badge"
      className={cn(
        badgeVariants({
          variant,
        }),
        className,
      )}
      {...props}
    />
  );
}

// Badge with Icon Support
type BadgeProps = React.ComponentPropsWithoutRef<typeof BadgeComponent> & {
  icon?: React.ReactElement | IconName;
  onClick?: () => void;
} & Record<string, unknown>;

const Badge = ({ icon, children, ...props }: BadgeProps) => {
  if (icon && typeof icon === "string") {
    icon = <IconComponent icon={icon as IconName} />;
  }
  return (
    <BadgeComponent {...props}>
      {icon}
      {children}
    </BadgeComponent>
  );
};

type BadgeVariant = NonNullable<BadgeVariantProps["variant"]>;

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<BadgeProps> = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx().propertiesPanel({
      label: "Children",
      description: "The content of the badge",
    }),
    icon: Prop.any<JSX.Element | IconName>()
      .propertiesPanel({
        label: "Icon",
        visibility: "SHOW_NAME",
        defaultOnAdd: "info",
        controlType: "ICON_SELECTOR",
      })
      .docs({
        description:
          "The icon to display in the component. You can use the Lucide icon library to find the icon you want.",
      }),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    variant: Prop.string<BadgeVariant>().propertiesPanel({
      label: "Variant",
      controlType: "DROP_DOWN",
      description: "The visual style of the badge",
      options: [
        { label: "Default", value: "default" },
        { label: "Secondary", value: "secondary" },
        { label: "Destructive", value: "destructive" },
        { label: "Outline", value: "outline" },
      ],
    }),
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onClick: Prop.eventHandler().propertiesPanel({
      label: "onClick",
      description: "Triggered when the badge is clicked",
    }),
  }),
};

// Editor Template
// Editor Config
const editorConfig: EditorConfig = {
  icon: "custom",
  isDroppable: false,
  description:
    "A versatile badge component for displaying status, labels, or tags",
};

// Register Component
registerComponent(Badge, propertiesDefinition).editorConfig(editorConfig);

export { Badge, badgeVariants };

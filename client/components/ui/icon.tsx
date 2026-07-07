import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import type { ReactNode } from "react";
import React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  tailwindStylesCategory,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

// Base Icon Component
interface IconComponentProps {
  icon?: IconName;
  children?: ReactNode;
  color?: string;
  strokeWidth?: number;
  onClick?: () => void;
  style?: React.CSSProperties;
  className?: string;
}

function IconComponent({
  icon,
  children,
  onClick,
  style,
  className,
  ...props
}: IconComponentProps) {
  if (icon) {
    return (
      <DynamicIcon
        name={icon}
        onClick={onClick}
        style={style}
        className={className}
        {...props}
      />
    );
  }

  if (
    children &&
    (React.isValidElement(children) ||
      (Array.isArray(children) && children.length > 0))
  ) {
    return (
      <span
        className={cn("inline-flex items-center justify-center", className)}
        style={style}
        onClick={onClick}
        {...props}
      >
        {children}
      </span>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center border-2 border-dashed border-gray-300 text-gray-400 text-xs",
        className,
      )}
      title={`Icon "${icon}" not found`}
      onClick={onClick}
      style={style}
      {...props}
    >
      ?
    </div>
  );
}

// Main Component with Registration
type IconProps = React.ComponentPropsWithoutRef<typeof IconComponent> & {
  name?: string;
} & Record<string, unknown>;

const Icon = ({
  children,
  className,
  // avoid passing name to the icon component, because we need to use icon as DynamicIcon.name
  name: _name,
  ...props
}: IconProps) => {
  return (
    <IconComponent className={cn("w-fit h-fit", className)} {...props}>
      {children}
    </IconComponent>
  );
};

// Properties Definition
const propertiesDefinition = {
  general: Section.category(PropsCategory.Content).children({
    icon: Prop.string<IconName>().propertiesPanel({
      label: "Icon name",
      controlType: "ICON_SELECTOR",
      description: "The name of the Lucide icon (e.g., 'heart', 'arrow-right')",
      placeholder: "heart" satisfies IconName,
    }),
    // no props panel for now
    children: Prop.jsx(),
  }),
  styles: tailwindStylesCategory({
    prioritizedTailwindProperties: ["stroke", "stroke-width"],
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onClick: Prop.eventHandler().propertiesPanel({
      label: "onClick",
      description: "Triggered when the icon is clicked",
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "custom",
  description:
    "A versatile icon component supporting Lucide icons and custom content",
};

// Registration
registerComponent(Icon, propertiesDefinition).editorConfig(editorConfig);

export { Icon };

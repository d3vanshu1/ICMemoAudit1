import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type * as React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

// Main Component
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

// Types
// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
> = {
  appearance: Section.category(PropsCategory.Appearance).children({
    orientation: Prop.string<"horizontal" | "vertical">().propertiesPanel({
      label: "Orientation",
      controlType: "DROP_DOWN",
      options: [
        { label: "Horizontal", value: "horizontal" },
        { label: "Vertical", value: "vertical" },
      ],
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  description: "A visual separator for dividing content",
  hasExtendedClickArea: true,
};

// Registration
registerComponent(Separator, propertiesDefinition).editorConfig(editorConfig);

export { Separator };

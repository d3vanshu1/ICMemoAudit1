import * as ProgressPrimitive from "@radix-ui/react-progress";
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

// Progress Component
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "bg-primary/20 relative h-2 w-full overflow-hidden rounded-full",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-primary h-full w-full flex-1 transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

type ProgressProps = React.ComponentProps<typeof Progress>;

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<ProgressProps> = {
  general: Section.category(PropsCategory.Content).children({
    value: Prop.number().propertiesPanel({
      label: "Value",
      controlType: "INPUT_TEXT",
      description: "The current progress value (0-100)",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    max: Prop.number().propertiesPanel({
      label: "Max value",
      description: "The maximum progress value",
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "custom",
  isDraggable: true,
  description:
    "Displays an indicator showing the completion progress of a task, typically displayed as a progress bar.",
};

// Registration
registerComponent(Progress, propertiesDefinition).editorConfig(editorConfig);

export { Progress };

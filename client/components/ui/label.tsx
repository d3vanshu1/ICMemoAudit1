import * as LabelPrimitive from "@radix-ui/react-label";
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

// Label Component
function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

type LabelProps = React.ComponentProps<typeof Label>;

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<LabelProps> = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx().propertiesPanel({
      label: "Text",
      controlType: "INPUT_TEXT",
    }),
    htmlFor: Prop.string(),
  }),
};

// Editor Template
// Editor Config
const editorConfig: EditorConfig = {
  icon: "button",
  description: "A label component for forms and inputs",
};

// Register Component
registerComponent(Label, propertiesDefinition).editorConfig(editorConfig);

export { Label };

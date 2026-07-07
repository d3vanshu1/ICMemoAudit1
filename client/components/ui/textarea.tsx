import type * as React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  tailwindStylesCategory,
  type PropertiesPanelDefinition,
} from "@superblocksteam/library";
import { type EditorConfig } from "@superblocksteam/library";

import { cn } from "@/lib/utils";

// Main Component
function Textarea({
  className,
  style,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      data-slot="textarea"
      style={style}
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
    />
  );
}

// Types
type TextareaProps = React.ComponentProps<"textarea">;

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<TextareaProps> = {
  general: Section.category(PropsCategory.Content).children({
    value: Prop.string().propertiesPanel({
      label: "Value",
      controlType: "INPUT_TEXT",
      description: "The controlled value of the textarea",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    defaultValue: Prop.string().propertiesPanel({
      label: "Default value",
      controlType: "INPUT_TEXT",
      description: "The current value of the textarea",
    }),
    placeholder: Prop.string().propertiesPanel({
      label: "Placeholder",
      controlType: "INPUT_TEXT",
      description: "Placeholder text shown when textarea is empty",
    }),
    rows: Prop.number().propertiesPanel({
      label: "Rows",
      controlType: "INPUT_TEXT",
      description: "Number of visible text lines",
      isRemovable: true,
      visibility: "SHOW_NAME",
      defaultOnAdd: 3,
    }),
  }),
  styles: tailwindStylesCategory({
    prioritizedTailwindProperties: ["resize"],
  }),

  interaction: Section.category(PropsCategory.Interaction).children({
    disabled: Prop.boolean().propertiesPanel({
      label: "Disabled",
      controlType: "SWITCH",
      description: "Whether the textarea is disabled",
    }),
    readOnly: Prop.boolean().propertiesPanel({
      label: "Read only",
      controlType: "SWITCH",
      description: "Whether the textarea is read only",
    }),
    autoFocus: Prop.boolean().propertiesPanel({
      label: "Auto focus",
      controlType: "SWITCH",
      description: "Whether the textarea should auto focus on page load",
    }),
    minLength: Prop.number().propertiesPanel({
      label: "Min length",
      controlType: "INPUT_TEXT",
      description: "Minimum number of characters required",
      isRemovable: true,
      visibility: "SHOW_NAME",
      defaultOnAdd: 0,
    }),
    maxLength: Prop.number().propertiesPanel({
      label: "Max length",
      controlType: "INPUT_TEXT",
      description: "Maximum number of characters allowed",
      isRemovable: true,
      visibility: "SHOW_NAME",
      defaultOnAdd: 1000,
    }),
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onChange: Prop.eventHandler().propertiesPanel({
      label: "On change",
      description: "Triggered when the textarea value changes",
      computedArgs: [
        {
          name: "event",
          type: "object",
          description: "The event object",
        },
      ],
    }),
    onFocus: Prop.eventHandler().propertiesPanel({
      label: "On focus",
      description: "Triggered when the textarea receives focus",
    }),
    onBlur: Prop.eventHandler().propertiesPanel({
      label: "On blur",
      description: "Triggered when the textarea loses focus",
    }),
    onKeyDown: Prop.eventHandler().propertiesPanel({
      label: "On key down",
      description: "Triggered when a key is pressed down",
      computedArgs: [
        {
          name: "event",
          type: "object",
          description: "The event object",
        },
      ],
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "input",
  description:
    "A multi-line textarea component for collecting longer text input",
};

// Registration
registerComponent(Textarea, propertiesDefinition).editorConfig(editorConfig);

export { Textarea };

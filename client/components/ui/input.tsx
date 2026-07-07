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

// Input Component
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

type InputProps = React.ComponentProps<typeof Input>;

// Input type constants for property visibility
const AUTO_COMPLETE_INPUT_TYPES = ["text", "email", "password", "url"];
const TEXT_INPUT_TYPES = ["text", "email", "password", "url"];
const NUMERIC_INPUT_TYPES = ["number"];
const STEP_INPUT_TYPES = ["number"];

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<InputProps> = {
  general: Section.category(PropsCategory.Content).children({
    value: Prop.string().propertiesPanel({
      label: "Value",
      controlType: "INPUT_TEXT",
      description: "The controlled value of the input",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    defaultValue: Prop.string().propertiesPanel({
      label: "Default value",
      controlType: "INPUT_TEXT",
      description: "The default value of the input",
    }),
    placeholder: Prop.string().propertiesPanel({
      label: "Placeholder",
      controlType: "INPUT_TEXT",
      description: "Placeholder text shown when input is empty",
    }),
    type: Prop.string<
      "text" | "email" | "password" | "number" | "url"
    >().propertiesPanel({
      label: "Type",
      controlType: "DROP_DOWN",
      description: "The type of input",
      options: [
        { label: "Text", value: "text" },
        { label: "Email", value: "email" },
        { label: "Password", value: "password" },
        { label: "Number", value: "number" },
        { label: "URL", value: "url" },
      ],
    }),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    autoComplete: Prop.string().propertiesPanel({
      label: "Auto complete",
      controlType: "DROP_DOWN",
      description: "Hint for form autofill feature",
      options: [
        { label: "Off", value: "off" },
        { label: "On", value: "on" },
        { label: "Name", value: "name" },
        { label: "Email", value: "email" },
        { label: "Username", value: "username" },
        { label: "Current password", value: "current-password" },
        { label: "New password", value: "new-password" },
        { label: "URL", value: "url" },
      ],
      isRemovable: true,
      visibility: "SHOW_NAME",
      defaultOnAdd: "off",
      isVisible: function (this: { type?: string }) {
        return AUTO_COMPLETE_INPUT_TYPES.includes(this.type ?? "text");
      },
    }),
  }),

  interaction: Section.category(PropsCategory.Interaction)
    .children({
      disabled: Prop.boolean().propertiesPanel({
        label: "Disabled",
        controlType: "SWITCH",
        description: "Whether the input is disabled",
      }),
      readOnly: Prop.boolean().propertiesPanel({
        label: "Read only",
        controlType: "SWITCH",
        description: "Whether the input is read only",
      }),
      autoFocus: Prop.boolean().propertiesPanel({
        label: "Auto focus",
        controlType: "SWITCH",
        description: "Whether the input should auto focus on page load",
      }),
    })
    .add({
      minLength: Prop.number().propertiesPanel({
        label: "Min length",
        controlType: "INPUT_TEXT",
        description: "Minimum number of characters required",
        isRemovable: true,
        visibility: "SHOW_NAME",
        defaultOnAdd: 0,
        isVisible: function (this: { type?: string }) {
          return TEXT_INPUT_TYPES.includes(this.type ?? "text");
        },
      }),
      maxLength: Prop.number().propertiesPanel({
        label: "Max length",
        controlType: "INPUT_TEXT",
        description: "Maximum number of characters allowed",
        isRemovable: true,
        visibility: "SHOW_NAME",
        defaultOnAdd: 100,
        isVisible: function (this: { type?: string }) {
          return TEXT_INPUT_TYPES.includes(this.type ?? "text");
        },
      }),
    })
    .add({
      min: Prop.number().propertiesPanel({
        label: "Min value",
        controlType: "INPUT_TEXT",
        description: "Minimum value for number inputs",
        isRemovable: true,
        visibility: "SHOW_NAME",
        defaultOnAdd: 0,
        isVisible: function (this: { type?: string }) {
          return NUMERIC_INPUT_TYPES.includes(this.type ?? "text");
        },
      }),
      max: Prop.number().propertiesPanel({
        label: "Max value",
        controlType: "INPUT_TEXT",
        description: "Maximum value for number inputs",
        isRemovable: true,
        visibility: "SHOW_NAME",
        defaultOnAdd: 100,
        isVisible: function (this: { type?: string }) {
          return NUMERIC_INPUT_TYPES.includes(this.type ?? "text");
        },
      }),
      step: Prop.number().propertiesPanel({
        label: "Step",
        controlType: "INPUT_TEXT",
        description: "Step value for number inputs",
        isRemovable: true,
        visibility: "SHOW_NAME",
        defaultOnAdd: 1,
        isVisible: function (this: { type?: string }) {
          return STEP_INPUT_TYPES.includes(this.type ?? "text");
        },
      }),
    }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onChange: Prop.eventHandler().propertiesPanel({
      label: "On change",
      description: "Triggered when the input value changes",
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
      description: "Triggered when the input receives focus",
    }),
    onBlur: Prop.eventHandler().propertiesPanel({
      label: "On blur",
      description: "Triggered when the input loses focus",
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
  description: "A versatile input component for collecting user data",
};

// Registration
registerComponent(Input, propertiesDefinition).editorConfig(editorConfig);

export { Input };

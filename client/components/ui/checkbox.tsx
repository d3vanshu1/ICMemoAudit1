import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { CheckIcon } from "lucide-react";
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

// Base Checkbox Component
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      {...props}
      className={cn(
        "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

// Checkbox Props
type CheckboxProps = React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  onCheckedChange?: (checked: boolean) => void;
  defaultChecked?: boolean;
};

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<CheckboxProps> = {
  general: Section.category(PropsCategory.Content).children({
    checked: Prop.boolean().propertiesPanel({
      label: "Checked",
      controlType: "SWITCH",
      description:
        "The controlled state of the checkbox. Must be used in conjunction with `onCheckedChange`",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    defaultChecked: Prop.boolean().propertiesPanel({
      label: "Default checked",
      controlType: "SWITCH",
      description: "Whether the checkbox is checked by default",
    }),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    disabled: Prop.boolean().propertiesPanel({
      label: "Disabled",
      controlType: "SWITCH",
      description: "Whether the checkbox is disabled",
    }),
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onCheckedChange: Prop.eventHandler().propertiesPanel({
      label: "onChange",
      description: "Triggered when the checkbox state changes",
      computedArgs: [
        {
          name: "checked",
          type: "boolean",
          description: "Whether the checkbox is checked",
        },
      ],
    }),
  }),
};

// Editor Template
// Editor Config
const editorConfig: EditorConfig = {
  icon: "checkbox",
  description:
    "A control that allows the user to toggle between checked and not checked",
};

// Register Component
registerComponent(Checkbox, propertiesDefinition).editorConfig(editorConfig);

export { Checkbox };

import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDownIcon } from "lucide-react";
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

// Base Accordion Components
function Accordion({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

interface AccordionItemProps extends React.ComponentProps<
  typeof AccordionPrimitive.Item
> {
  className?: string;
  overrideClassName?: string;
}

function AccordionItem({
  className,
  overrideClassName,
  ...props
}: AccordionItemProps) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={overrideClassName ?? cn("border-b last:border-b-0", className)}
      {...props}
    />
  );
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "focus-visible:border-ring focus-visible:ring-ring/50 flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm"
      {...props}
    >
      <div className={cn("pt-0 pb-4", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

// AccordionItem Properties Definition
const accordionItemPropertiesDefinition: PropertiesPanelDefinition<AccordionItemProps> =
  {
    general: Section.category(PropsCategory.Content).children({
      value: Prop.string().propertiesPanel({
        label: "Value",
        description:
          "Unique identifier for this accordion item. Used to identify which item is open/closed",
      }),
      children: Prop.jsx().propertiesPanel({
        label: "Children",
        description: "The content of the accordion item",
      }),
    }),
  };

registerComponent(
  AccordionItem,
  accordionItemPropertiesDefinition,
).editorConfig({
  isDroppable: false,
  isDraggable: false,
});

// Accordion Properties Definition
interface AccordionPropsForPanel {
  type?: "single" | "multiple";
  value?: string | string[];
  defaultValue?: string | string[];
  onValueChange?: (value: string | string[]) => void;
  collapsible?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
}

const accordionPropertiesDefinition: PropertiesPanelDefinition<AccordionPropsForPanel> =
  {
    general: Section.category(PropsCategory.Content).children({
      value: Prop.any<string | string[]>().propertiesPanel({
        label: "Value",
        controlType: "INPUT_TEXT",
        description:
          "The controlled value of the accordion (string or array of strings)",
        isRemovable: true,
        visibility: "SHOW_NAME",
      }),
      type: Prop.string<"single" | "multiple">().propertiesPanel({
        label: "Type",
        controlType: "RADIO_BUTTON_GROUP",
        options: [
          {
            label: "Single",
            value: "single",
          },
          {
            label: "Multiple",
            value: "multiple",
          },
        ],
      }),
      children: Prop.jsx().propertiesPanel({
        label: "Children",
        description: "The accordion items to display",
      }),
      defaultValue: Prop.any<string | string[]>().propertiesPanel({
        label: "Default value",
        controlType: "INPUT_TEXT",
        description:
          "The default value of the accordion (string or array of strings)",
        defaultOnAdd: "item-1",
        visibility: "SHOW_NAME",
        isRemovable: true,
      }),
      collapsible: Prop.boolean().propertiesPanel({
        label: "Collapsible",
        controlType: "SWITCH",
        description: "Allow all items to be collapsed",
      }),
    }),

    interaction: Section.category(PropsCategory.Interaction).children({
      disabled: Prop.boolean().propertiesPanel({
        label: "Disabled",
        controlType: "SWITCH",
        description: "Disable the accordion",
      }),
    }),

    events: Section.category(PropsCategory.EventHandlers).children({
      onValueChange: Prop.eventHandler().propertiesPanel({
        label: "onValueChange",
        description: "Triggered when the accordion value changes",
        computedArgs: [
          {
            name: "value",
            type: "string",
            description: "The selected value",
          },
        ],
      }),
    }),
  };

// Editor Template
// Editor Config
const editorConfig: EditorConfig = {
  icon: "custom",
  isDroppable: false,
};

// Register Accordion Component
registerComponent(Accordion, accordionPropertiesDefinition).editorConfig(
  editorConfig,
);

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };

import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";

import {
  Prop,
  Section,
  PropsCategory,
  registerComponent,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };

// Properties Definition for Popover (root)
const popoverPropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof Popover>
> = {
  general: Section.category(PropsCategory.Content).children({
    open: Prop.boolean().propertiesPanel({
      label: "Open",
      controlType: "SWITCH",
      description:
        "The controlled open state of the popover. Must be used in conjunction with `onOpenChange`.",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    children: Prop.jsx(),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    defaultOpen: Prop.boolean().propertiesPanel({
      label: "Default open",
      description: "Whether the popover is open by default",
    }),
    modal: Prop.boolean().propertiesPanel({
      label: "Modal",
      description:
        "Whether the popover should be modal, trapping focus and blocking interaction with other elements.",
    }),
  }),
  events: Section.category(PropsCategory.EventHandlers).children({
    onOpenChange: Prop.eventHandler().propertiesPanel({
      label: "onOpenChange",
      computedArgs: [
        {
          name: "open",
          type: "boolean",
          description: "Whether the popover is open",
        },
      ],
    }),
  }),
};

const popoverEditorConfig: EditorConfig = {
  icon: "modal",
  isDetached: true,
  isDraggable: false,
  description:
    "A modal popover that displays rich content in relation to a trigger element.",
};

// Properties Definition for PopoverContent
const popoverContentPropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof PopoverContent>
> = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    side: Prop.string<"top" | "right" | "bottom" | "left">().propertiesPanel({
      label: "Side",
      controlType: "DROP_DOWN",
      description: "The preferred side of the trigger to render against",
      options: [
        { label: "Top", value: "top" },
        { label: "Right", value: "right" },
        { label: "Bottom", value: "bottom" },
        { label: "Left", value: "left" },
      ],
    }),
    align: Prop.string<"start" | "center" | "end">().propertiesPanel({
      label: "Align",
      controlType: "DROP_DOWN",
      description: "The preferred alignment against the trigger",
      options: [
        { label: "Start", value: "start" },
        { label: "Center", value: "center" },
        { label: "End", value: "end" },
      ],
    }),
    sideOffset: Prop.number().propertiesPanel({
      label: "Side offset",
      description: "The distance in pixels from the trigger",
    }),
    alignOffset: Prop.number().propertiesPanel({
      label: "Align offset",
      description: "An offset in pixels from the alignment axis",
    }),
    avoidCollisions: Prop.boolean().propertiesPanel({
      label: "Avoid collisions",
      description:
        "Whether the content should avoid collisions with other elements",
    }),
  }),
};

const childrenPropertiesDefinition = {
  general: Section.category(PropsCategory.Content).children({
    children: Prop.jsx(),
  }),
};

// Register Components
registerComponent(Popover, popoverPropertiesDefinition).editorConfig(
  popoverEditorConfig,
);
registerComponent(PopoverTrigger, childrenPropertiesDefinition);
registerComponent(PopoverContent, popoverContentPropertiesDefinition);
registerComponent(PopoverAnchor);

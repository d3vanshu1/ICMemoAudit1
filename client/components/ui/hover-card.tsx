import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
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

function HoverCard({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };

// Properties Definition for HoverCard (root)
const hoverCardPropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof HoverCard>
> = {
  general: Section.category(PropsCategory.Content).children({
    open: Prop.boolean().propertiesPanel({
      label: "Open",
      controlType: "SWITCH",
      description:
        "The controlled open state of the hover card. Must be used in conjunction with `onOpenChange`.",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    children: Prop.jsx(),
    openDelay: Prop.number().propertiesPanel({
      label: "Open delay",
      description:
        "The duration from when the mouse enters the trigger until the hover card opens (in milliseconds)",
    }),
    closeDelay: Prop.number().propertiesPanel({
      label: "Close delay",
      description:
        "The duration from when the mouse leaves the trigger until the hover card closes (in milliseconds)",
    }),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    defaultOpen: Prop.boolean().propertiesPanel({
      label: "Default open",
      description: "Whether the hover card is open by default",
    }),
  }),
  events: Section.category(PropsCategory.EventHandlers).children({
    onOpenChange: Prop.eventHandler().propertiesPanel({
      label: "onOpenChange",
      computedArgs: [
        {
          name: "open",
          type: "boolean",
          description: "Whether the hover card is open",
        },
      ],
    }),
  }),
};

const hoverCardEditorConfig: EditorConfig = {
  icon: "custom",
  isDetached: true,
  isDraggable: false,
  description:
    "A hover card component for displaying contextual information on hover",
};

// Properties Definition for HoverCardContent
const hoverCardContentPropertiesDefinition: PropertiesPanelDefinition<
  React.ComponentPropsWithoutRef<typeof HoverCardContent>
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
registerComponent(HoverCard, hoverCardPropertiesDefinition).editorConfig(
  hoverCardEditorConfig,
);
registerComponent(HoverCardTrigger, childrenPropertiesDefinition);
registerComponent(HoverCardContent, hoverCardContentPropertiesDefinition);

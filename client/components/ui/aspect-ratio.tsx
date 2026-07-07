import * as AspectRatioPrimitive from "@radix-ui/react-aspect-ratio";
import type React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

// Base AspectRatio Component
function AspectRatio({
  ...props
}: React.ComponentProps<typeof AspectRatioPrimitive.Root>) {
  return <AspectRatioPrimitive.Root data-slot="aspect-ratio" {...props} />;
}

// AspectRatio Props
type AspectRatioProps = React.ComponentPropsWithoutRef<typeof AspectRatio>;

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<AspectRatioProps> = {
  general: Section.category(PropsCategory.Content).children({
    ratio: Prop.number().propertiesPanel({
      label: "Aspect ratio",
      description: "The desired width/height ratio (e.g., 1.777 for 16:9)",
      placeholder: "1.777",
    }),
  }),
};

// Editor Template
// Editor Config
const editorConfig: EditorConfig = {
  description:
    "Container that maintains a consistent aspect ratio for content, useful for responsive images and videos",
  isDroppable: true,
};

// Register Component
registerComponent(AspectRatio, propertiesDefinition).editorConfig(editorConfig);

export { AspectRatio };

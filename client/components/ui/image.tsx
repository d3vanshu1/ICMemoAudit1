import * as React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  tailwindStylesCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

// Base Image Component
interface ImageComponentProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  alt?: string;
}

const ImageComponent = React.forwardRef<HTMLImageElement, ImageComponentProps>(
  ({ alt = "", ...props }, ref) => {
    return <img ref={ref} alt={alt} {...props} />;
  },
);

ImageComponent.displayName = "ImageComponent";

// Main Component
type ImageProps = React.ComponentPropsWithoutRef<typeof ImageComponent>;

const Image = ({ children: _, ...props }: ImageProps) => {
  return <ImageComponent {...props} />;
};

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<ImageProps> = {
  general: Section.category(PropsCategory.Content).children({
    src: Prop.string().propertiesPanel({
      label: "Image URL",
      description: "The URL of the image to display",
    }),
    alt: Prop.string().propertiesPanel({
      label: "Alt text",
      description: "Alternative text for the image (for accessibility)",
    }),
  }),
  styles: tailwindStylesCategory({
    prioritizedTailwindProperties: ["rounded", "object-fit", "object-position"],
  }),
  events: Section.category(PropsCategory.EventHandlers).children({
    onClick: Prop.eventHandler().propertiesPanel({
      label: "onClick",
      description: "Triggered when the image is clicked",
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "image",
  description:
    "Image component that Maintains a consistent aspect ratio for content, useful for responsive images and videos",
  isDroppable: true,
};

// Registration
registerComponent(Image, propertiesDefinition).editorConfig(editorConfig);

export { Image };

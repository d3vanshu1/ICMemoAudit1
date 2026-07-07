import * as NavigationMenuPrimitive from "@radix-ui/react-navigation-menu";
import { ChevronDownIcon } from "lucide-react";
import { type IconName } from "lucide-react/dynamic";
import * as React from "react";
import { useNavigate } from "react-router";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { useActivePage } from "@/components/hooks/use-active-page";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// Types
interface MenuItem {
  label: string;
  href?: string;
  content?: {
    title: string;
    description?: string;
    href: string;
    icon?: IconName;
  }[];
}

// Constants
const TRIGGER_CLASSES =
  "group inline-flex h-9 w-max items-center justify-center rounded-md bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=open]:hover:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:focus:bg-accent data-[state=open]:bg-accent/50 focus-visible:ring-ring/50 outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1";

// Primitive Components
function NavigationMenuRoot({
  className,
  children,
  viewport = true,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Root> & {
  viewport?: boolean;
}) {
  return (
    <NavigationMenuPrimitive.Root
      data-slot="navigation-menu"
      data-viewport={viewport}
      className={cn(
        "group/navigation-menu relative flex max-w-max flex-1 items-center justify-center",
        className,
      )}
      {...props}
    >
      {children}
      {viewport && <NavigationMenuViewport />}
    </NavigationMenuPrimitive.Root>
  );
}

function NavigationMenuList({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.List>) {
  return (
    <NavigationMenuPrimitive.List
      data-slot="navigation-menu-list"
      className={cn(
        "group flex flex-1 list-none items-center justify-center gap-1",
        className,
      )}
      {...props}
    />
  );
}

function NavigationMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Item>) {
  return (
    <NavigationMenuPrimitive.Item
      data-slot="navigation-menu-item"
      className={cn("relative", className)}
      {...props}
    />
  );
}

function NavigationMenuTrigger({
  className,
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof NavigationMenuPrimitive.Trigger>,
  "asChild"
>) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn(TRIGGER_CLASSES, className)}
      {...props}
    >
      {children}{" "}
      <ChevronDownIcon
        className="relative top-[1px] ml-1 size-3 transition duration-300 group-data-[state=open]:rotate-180"
        aria-hidden="true"
      />
    </NavigationMenuPrimitive.Trigger>
  );
}

function NavigationMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Content>) {
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn(
        "data-[motion^=from-]:animate-in data-[motion^=to-]:animate-out data-[motion^=from-]:fade-in data-[motion^=to-]:fade-out data-[motion=from-end]:slide-in-from-right-52 data-[motion=from-start]:slide-in-from-left-52 data-[motion=to-end]:slide-out-to-right-52 data-[motion=to-start]:slide-out-to-left-52 top-0 left-0 w-full p-2 pr-2.5 md:absolute md:w-auto",
        "group-data-[viewport=false]/navigation-menu:bg-popover group-data-[viewport=false]/navigation-menu:text-popover-foreground group-data-[viewport=false]/navigation-menu:data-[state=open]:animate-in group-data-[viewport=false]/navigation-menu:data-[state=closed]:animate-out group-data-[viewport=false]/navigation-menu:data-[state=closed]:zoom-out-95 group-data-[viewport=false]/navigation-menu:data-[state=open]:zoom-in-95 group-data-[viewport=false]/navigation-menu:data-[state=open]:fade-in-0 group-data-[viewport=false]/navigation-menu:data-[state=closed]:fade-out-0 group-data-[viewport=false]/navigation-menu:top-full group-data-[viewport=false]/navigation-menu:mt-1.5 group-data-[viewport=false]/navigation-menu:overflow-hidden group-data-[viewport=false]/navigation-menu:rounded-md group-data-[viewport=false]/navigation-menu:border group-data-[viewport=false]/navigation-menu:shadow group-data-[viewport=false]/navigation-menu:duration-200 **:data-[slot=navigation-menu-link]:focus:ring-0 **:data-[slot=navigation-menu-link]:focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

function NavigationMenuViewport({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Viewport>) {
  return (
    <div
      className={cn(
        "absolute top-full left-0 isolate z-50 flex justify-center",
      )}
    >
      <NavigationMenuPrimitive.Viewport
        data-slot="navigation-menu-viewport"
        className={cn(
          "origin-top-center bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-90 relative mt-1.5 h-[var(--radix-navigation-menu-viewport-height)] w-full overflow-hidden rounded-md border shadow md:w-[var(--radix-navigation-menu-viewport-width)]",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function NavigationMenuLink({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Link>) {
  return (
    <NavigationMenuPrimitive.Link
      data-slot="navigation-menu-link"
      className={cn(
        "data-[active=true]:focus:bg-accent data-[active=true]:hover:bg-accent data-[active=true]:bg-accent/50 data-[active=true]:text-accent-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:ring-ring/50 [&_svg:not([class*='text-'])]:text-muted-foreground flex flex-col gap-1 rounded-sm p-2 text-sm transition-all outline-none focus-visible:ring-[3px] focus-visible:outline-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function NavigationMenuIndicator({
  className,
  ...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Indicator>) {
  return (
    <NavigationMenuPrimitive.Indicator
      data-slot="navigation-menu-indicator"
      className={cn(
        "data-[state=visible]:animate-in data-[state=hidden]:animate-out data-[state=hidden]:fade-out data-[state=visible]:fade-in top-full z-[1] flex h-1.5 items-end justify-center overflow-hidden",
        className,
      )}
      {...props}
    >
      <div className="bg-border relative top-[60%] h-2 w-2 rotate-45 rounded-tl-sm shadow-md" />
    </NavigationMenuPrimitive.Indicator>
  );
}

// Main Component
type NavigationMenuProps = React.ComponentPropsWithoutRef<
  typeof NavigationMenuRoot
> & {
  menuItems?: MenuItem[];
  disabled?: boolean;
  onItemClick?: (href?: string) => void;
};

const NavigationMenu = ({
  menuItems,
  disabled,
  onItemClick,
  children: _children,
  ...props
}: NavigationMenuProps) => {
  const { isPageActive } = useActivePage();
  const navigate = useNavigate();
  const handleItemClick = React.useCallback(
    (item: MenuItem, href?: string) => {
      const targetHref = href || item.href;
      void onItemClick?.(targetHref);
      if (targetHref) {
        navigate(targetHref);
      }
    },
    [onItemClick, navigate],
  );
  const normalizedMenuItems: MenuItem[] = React.useMemo(() => {
    if (!Array.isArray(menuItems)) return [];
    return menuItems.map((item: any) => ({
      label: item?.label?.toString() ?? "",
      href: item?.href?.toString(),
      icon: item?.icon?.toString(),
      content: Array.isArray(item?.content)
        ? item.content.map((contentItem: any) => ({
            title: contentItem?.title?.toString() ?? "",
            description: contentItem?.description?.toString() ?? "",
            href: contentItem?.href?.toString() ?? "",
            icon: contentItem?.icon?.toString() ?? "",
          }))
        : undefined,
    }));
  }, [menuItems]);
  return (
    <NavigationMenuRoot {...props}>
      <NavigationMenuList>
        {normalizedMenuItems.map((item, index) => (
          <NavigationMenuItem key={`${item.label}-${index}`}>
            {item.content && item.content.length > 0 ? (
              <>
                <NavigationMenuTrigger
                  className={cn(
                    item.href &&
                      isPageActive(item.href) &&
                      "bg-accent text-accent-foreground",
                  )}
                  disabled={disabled}
                >
                  {item.label}
                </NavigationMenuTrigger>
                <NavigationMenuContent>
                  <div className="grid w-[400px] gap-3 p-4 md:w-[500px] md:grid-cols-2 lg:w-[600px]">
                    {item.content.map((contentItem, contentIndex) => (
                      <NavigationMenuLink
                        key={`${contentItem.title}-${contentIndex}`}
                        className="cursor-pointer"
                        onClick={() => handleItemClick(item, contentItem.href)}
                      >
                        <div className="flex items-center gap-2">
                          {contentItem.icon && <Icon icon={contentItem.icon} />}
                          {contentItem.title}
                        </div>
                        <p className="line-clamp-2 text-sm leading-snug text-muted-foreground">
                          {contentItem.description}
                        </p>
                      </NavigationMenuLink>
                    ))}
                  </div>
                </NavigationMenuContent>
              </>
            ) : (
              <NavigationMenuLink
                onClick={() => handleItemClick(item)}
                className={cn(
                  TRIGGER_CLASSES,
                  "cursor-pointer",
                  item.href &&
                    isPageActive(item.href) &&
                    "bg-accent text-accent-foreground",
                  disabled && "pointer-events-none opacity-50",
                )}
              >
                {item.label}
              </NavigationMenuLink>
            )}
          </NavigationMenuItem>
        ))}
      </NavigationMenuList>
    </NavigationMenuRoot>
  );
};

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<NavigationMenuProps> = {
  general: Section.category(PropsCategory.Content).children({
    menuItems: Prop.array<MenuItem>()

      .propertiesPanel({
        label: "Menu items",
        controlType: "FUNCTION_CODE_EDITOR",
        description:
          "Array of menu items. Items with 'content' array become dropdowns.",
      }),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    disabled: Prop.boolean().propertiesPanel({
      label: "Disabled",
      controlType: "SWITCH",
      description: "Whether the navigation menu is disabled",
    }),
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onItemClick: Prop.eventHandler().propertiesPanel({
      label: "onItemClick",
      description: "Triggered when a menu item is clicked",
      computedArgs: [
        {
          name: "href",
          type: "string",
          description: "The clicked item's href",
        },
      ],
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "menu",
  description: "A collection of links for navigating websites",
};

// Registration
registerComponent(NavigationMenu, propertiesDefinition).editorConfig(
  editorConfig,
);

export {
  NavigationMenu,
  NavigationMenuRoot,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuContent,
  NavigationMenuTrigger,
  NavigationMenuLink,
  NavigationMenuIndicator,
  NavigationMenuViewport,
};

import React from "react";
import { cn } from "@/lib/utils";

export const Container = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <div className={cn("mx-auto w-full max-w-marketing px-4 sm:px-6 lg:px-8", className)}>{children}</div>
);

import type { ComponentProps } from "react";
import type { ProjectStackIconId } from "../../../shared/project-stack-icons";
import "./ProjectStackIcon.css";
import react from "../assets/project-stacks/react.svg";
import nextjs from "../assets/project-stacks/nextjs.svg";
import nestjs from "../assets/project-stacks/nestjs.svg";
import vue from "../assets/project-stacks/vuejs.svg";
import nuxt from "../assets/project-stacks/nuxt.svg";
import svelte from "../assets/project-stacks/svelte.svg";
import astro from "../assets/project-stacks/astro.svg";
import angular from "../assets/project-stacks/angular.svg";
import express from "../assets/project-stacks/express.svg";
import laravel from "../assets/project-stacks/laravel.svg";
import django from "../assets/project-stacks/django.svg";
import fastapi from "../assets/project-stacks/fastapi.svg";
import javascript from "../assets/project-stacks/javascript.svg";
import typescript from "../assets/project-stacks/typescript.svg";
import python from "../assets/project-stacks/python.svg";
import go from "../assets/project-stacks/go.svg";
import rust from "../assets/project-stacks/rust.svg";
import java from "../assets/project-stacks/java.svg";
import csharp from "../assets/project-stacks/csharp.svg";
import ruby from "../assets/project-stacks/ruby.svg";
import php from "../assets/project-stacks/php.svg";
import swift from "../assets/project-stacks/swift.svg";
import c from "../assets/project-stacks/c.svg";
import cpp from "../assets/project-stacks/cplusplus.svg";

/** Unmodified Devicon SVGs, pinned to v2.17.0. See assets/project-stacks/manifest.json. */
const logos: Record<ProjectStackIconId, string> = {
  react,
  nextjs,
  nestjs,
  vue,
  nuxt,
  svelte,
  astro,
  angular,
  express,
  laravel,
  django,
  fastapi,
  javascript,
  typescript,
  python,
  go,
  rust,
  java,
  csharp,
  ruby,
  php,
  swift,
  c,
  cpp,
};

type ProjectStackIconProps = Omit<ComponentProps<"img">, "id" | "src" | "alt" | "width" | "height"> & { id: ProjectStackIconId; size?: number | string };

export function ProjectStackIcon({ id, size = 16, className, ...props }: ProjectStackIconProps) {
  return <img src={logos[id]} alt="" aria-hidden="true" width={size} height={size} draggable={false} className={`project-stack-logo ${className ?? ""}`} data-project-stack={id} {...props} />;
}

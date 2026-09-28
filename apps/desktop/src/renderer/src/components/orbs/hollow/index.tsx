// SPDX-License-Identifier: Apache-2.0
import { ShaderOrb, type ShaderOrbProps } from "../canvas";
import { hollowOrb } from "./variant";

export type HollowOrbProps = Omit<ShaderOrbProps, "variant">;

export const HollowOrb = ({ size = 36, ...rest }: HollowOrbProps) => <ShaderOrb variant={hollowOrb} size={size} {...rest} />;

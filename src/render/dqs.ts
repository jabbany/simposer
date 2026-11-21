// Dual quaternion skinning (Kavan et al. 2007) as a patch over three.js's
// linear blend skinning shader chunks.
//
// Linear blending averages bone matrices, which collapses volume where a
// vertex follows bones with very different rotations: the "candy wrapper"
// at a twisted wrist or the folded skin at a strongly bent hip. Blending
// rigid transforms as dual quaternions keeps limbs round instead, which
// matters for a figure used as anatomy reference. Uniform scale (the rig
// normalizes model size) is factored out and blended separately.

import { MeshDepthMaterial } from 'three';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';

const FUNCTIONS = /* glsl */ `
#ifdef USE_SKINNING
vec4 dqsQuatFromMat3( const in mat3 m ) {
  float tr = m[0][0] + m[1][1] + m[2][2];
  vec4 q;
  if ( tr > 0.0 ) {
    float s = sqrt( tr + 1.0 ) * 2.0;
    q = vec4( ( m[1][2] - m[2][1] ) / s, ( m[2][0] - m[0][2] ) / s, ( m[0][1] - m[1][0] ) / s, 0.25 * s );
  } else if ( m[0][0] > m[1][1] && m[0][0] > m[2][2] ) {
    float s = sqrt( 1.0 + m[0][0] - m[1][1] - m[2][2] ) * 2.0;
    q = vec4( 0.25 * s, ( m[1][0] + m[0][1] ) / s, ( m[2][0] + m[0][2] ) / s, ( m[1][2] - m[2][1] ) / s );
  } else if ( m[1][1] > m[2][2] ) {
    float s = sqrt( 1.0 + m[1][1] - m[0][0] - m[2][2] ) * 2.0;
    q = vec4( ( m[1][0] + m[0][1] ) / s, 0.25 * s, ( m[2][1] + m[1][2] ) / s, ( m[2][0] - m[0][2] ) / s );
  } else {
    float s = sqrt( 1.0 + m[2][2] - m[0][0] - m[1][1] ) * 2.0;
    q = vec4( ( m[2][0] + m[0][2] ) / s, ( m[2][1] + m[1][2] ) / s, 0.25 * s, ( m[0][1] - m[1][0] ) / s );
  }
  return normalize( q );
}
vec4 dqsQuatMul( const in vec4 a, const in vec4 b ) {
  return vec4( a.w * b.xyz + b.w * a.xyz + cross( a.xyz, b.xyz ), a.w * b.w - dot( a.xyz, b.xyz ) );
}
vec3 dqsRotate( const in vec4 q, const in vec3 v ) {
  return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v );
}
// one bone's object-space transform as (real, dual, scale)
void dqsBone( const in mat4 bone, out vec4 real, out vec4 dual, out float scale ) {
  mat4 t = bindMatrixInverse * bone * bindMatrix;
  scale = length( t[0].xyz );
  real = dqsQuatFromMat3( mat3( t ) / max( scale, 1e-8 ) );
  dual = 0.5 * dqsQuatMul( vec4( t[3].xyz, 0.0 ), real );
}
#endif
`;

const BLEND = /* glsl */ `
#include <skinbase_vertex>
#ifdef USE_SKINNING
  vec4 dqsR0; vec4 dqsD0; float dqsS0;
  vec4 dqsR1; vec4 dqsD1; float dqsS1;
  vec4 dqsR2; vec4 dqsD2; float dqsS2;
  vec4 dqsR3; vec4 dqsD3; float dqsS3;
  dqsBone( boneMatX, dqsR0, dqsD0, dqsS0 );
  dqsBone( boneMatY, dqsR1, dqsD1, dqsS1 );
  dqsBone( boneMatZ, dqsR2, dqsD2, dqsS2 );
  dqsBone( boneMatW, dqsR3, dqsD3, dqsS3 );
  // keep all rotations in the same hemisphere as the first
  float dqsW1 = skinWeight.y * sign( dot( dqsR0, dqsR1 ) + 1e-6 );
  float dqsW2 = skinWeight.z * sign( dot( dqsR0, dqsR2 ) + 1e-6 );
  float dqsW3 = skinWeight.w * sign( dot( dqsR0, dqsR3 ) + 1e-6 );
  vec4 dqsReal = skinWeight.x * dqsR0 + dqsW1 * dqsR1 + dqsW2 * dqsR2 + dqsW3 * dqsR3;
  vec4 dqsDual = skinWeight.x * dqsD0 + dqsW1 * dqsD1 + dqsW2 * dqsD2 + dqsW3 * dqsD3;
  float dqsLen = max( length( dqsReal ), 1e-8 );
  dqsReal /= dqsLen;
  dqsDual /= dqsLen;
  float dqsScale = dot( skinWeight, vec4( dqsS0, dqsS1, dqsS2, dqsS3 ) );
  vec3 dqsTranslation = 2.0 * ( dqsReal.w * dqsDual.xyz - dqsDual.w * dqsReal.xyz + cross( dqsReal.xyz, dqsDual.xyz ) );
#endif
`;

const NORMAL = /* glsl */ `
#ifdef USE_SKINNING
  objectNormal = dqsRotate( dqsReal, objectNormal );
  #ifdef USE_TANGENT
    objectTangent = dqsRotate( dqsReal, objectTangent );
  #endif
#endif
`;

const POSITION = /* glsl */ `
#ifdef USE_SKINNING
  transformed = dqsRotate( dqsReal, transformed * dqsScale ) + dqsTranslation;
#endif
`;

function patch(shader: WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <skinning_pars_vertex>', `#include <skinning_pars_vertex>\n${FUNCTIONS}`)
    .replace('#include <skinbase_vertex>', BLEND)
    .replace('#include <skinnormal_vertex>', NORMAL)
    .replace('#include <skinning_vertex>', POSITION);
}

/** Switch a material to dual quaternion skinning (no effect on unskinned meshes). */
export function useDualQuaternionSkinning<T extends Material>(material: T): T {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    patch(shader);
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|dqs`;
  return material;
}

/** Depth material for shadows that deforms the same way as the visible mesh. */
export function dqsDepthMaterial(): MeshDepthMaterial {
  return useDualQuaternionSkinning(new MeshDepthMaterial());
}

import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { RoundedBox } from '@react-three/drei';
import { makeFallbackLabel, makeLiquidTexture, makeBoxPattern } from './textures';

/**
 * Attempts to load the user's real product photo from /bottle-label.png.
 * Falls back to a procedurally-drawn gold-on-black label if the file is absent,
 * so the viewer always renders something on-brand.
 */
function useLabelTexture(): THREE.Texture {
  const fallback = useMemo(() => makeFallbackLabel(), []);
  const [tex, setTex] = useState<THREE.Texture>(fallback);

  useEffect(() => {
    const loader = new THREE.TextureLoader();
    loader.load(
      '/bottle-label.png',
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        setTex(t);
      },
      undefined,
      () => {
        /* keep fallback */
      },
    );
  }, []);

  return tex;
}

function Bow() {
  // Black satin bow: two cones for loops + a small knot, gold ring underneath.
  const satin = (
    <meshPhysicalMaterial color="#0c0c0c" roughness={0.35} clearcoat={0.6} clearcoatRoughness={0.4} />
  );
  return (
    <group position={[0, 1.52, 0.0]}>
      <mesh position={[-0.34, 0, 0]} rotation={[0, 0, Math.PI / 2.1]}>
        <coneGeometry args={[0.26, 0.6, 24]} />
        {satin}
      </mesh>
      <mesh position={[0.34, 0, 0]} rotation={[0, 0, -Math.PI / 2.1]}>
        <coneGeometry args={[0.26, 0.6, 24]} />
        {satin}
      </mesh>
      <mesh>
        <sphereGeometry args={[0.16, 24, 24]} />
        {satin}
      </mesh>
      {/* gold ring at the neck */}
      <mesh position={[0, -0.12, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.42, 0.05, 16, 48]} />
        <meshStandardMaterial color="#d4af37" metalness={1} roughness={0.25} />
      </mesh>
    </group>
  );
}

export default function Perfume() {
  const label = useLabelTexture();
  const liquid = useMemo(() => makeLiquidTexture(), []);
  const boxPattern = useMemo(() => makeBoxPattern(), []);

  return (
    <group position={[0, -0.4, 0]}>
      {/* ---- Presentation box (behind the bottle) ---- */}
      <group position={[-1.7, -0.15, -0.4]}>
        <RoundedBox args={[1.5, 3.1, 1.5]} radius={0.04} smoothness={4}>
          <meshStandardMaterial map={boxPattern} metalness={0.55} roughness={0.4} />
        </RoundedBox>
      </group>

      {/* ---- Glass bottle ---- */}
      <group>
        {/* outer glass shell */}
        <RoundedBox args={[1.25, 2.4, 0.78]} radius={0.09} smoothness={5} position={[0, 0, 0]}>
          <meshPhysicalMaterial
            color="#ffffff"
            transmission={0.9}
            thickness={0.6}
            roughness={0.06}
            ior={1.5}
            clearcoat={1}
            clearcoatRoughness={0.05}
            transparent
            opacity={0.55}
          />
        </RoundedBox>

        {/* inner liquid (black -> amber gradient) */}
        <mesh position={[0, -0.05, 0]}>
          <boxGeometry args={[1.05, 2.1, 0.6]} />
          <meshStandardMaterial map={liquid} roughness={0.25} metalness={0.1} />
        </mesh>

        {/* front label — user's photo, or procedural fallback */}
        <mesh position={[0, 0.05, 0.4]}>
          <planeGeometry args={[1.02, 1.7]} />
          <meshStandardMaterial map={label} transparent roughness={0.5} />
        </mesh>

        {/* neck */}
        <mesh position={[0, 1.35, 0]}>
          <cylinderGeometry args={[0.28, 0.34, 0.35, 32]} />
          <meshPhysicalMaterial color="#ffffff" transmission={0.85} thickness={0.4} roughness={0.1} transparent opacity={0.5} />
        </mesh>

        {/* faceted black cap */}
        <mesh position={[0, 1.95, 0]}>
          <cylinderGeometry args={[0.3, 0.32, 0.8, 8]} />
          <meshPhysicalMaterial color="#080808" roughness={0.15} clearcoat={1} clearcoatRoughness={0.08} metalness={0.2} />
        </mesh>

        <Bow />
      </group>
    </group>
  );
}

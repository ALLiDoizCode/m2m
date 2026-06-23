import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, ContactShadows, Lightformer } from '@react-three/drei';
import Perfume from './Perfume';

export default function App() {
  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <Canvas
        camera={{ position: [0, 0.3, 6], fov: 38 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#f3eee9']} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[4, 6, 5]} intensity={1.6} castShadow />
        <directionalLight position={[-5, 2, -3]} intensity={0.5} color="#ffd9a0" />

        <Suspense fallback={null}>
          <Perfume />
          {/* In-scene studio environment (no network/HDR fetch) for glass reflections */}
          <Environment resolution={256}>
            <Lightformer intensity={2.2} position={[0, 4, 2]} scale={[8, 4, 1]} color="#ffffff" />
            <Lightformer intensity={1.2} position={[-4, 1, 2]} scale={[4, 6, 1]} color="#fff0d8" />
            <Lightformer intensity={1.0} position={[4, 0, 3]} scale={[4, 6, 1]} color="#ffffff" />
            <Lightformer intensity={0.8} position={[0, -3, 2]} scale={[8, 3, 1]} color="#d8c4a0" />
          </Environment>
        </Suspense>

        <ContactShadows position={[0, -1.95, 0]} opacity={0.35} scale={10} blur={2.6} far={4} />

        {/* drag to rotate + scroll/pinch to zoom */}
        <OrbitControls
          enablePan={false}
          minDistance={3.5}
          maxDistance={9}
          minPolarAngle={Math.PI / 4}
          maxPolarAngle={Math.PI / 1.8}
          autoRotate={false}
        />
      </Canvas>

      <div
        style={{
          position: 'absolute',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 13,
          letterSpacing: '0.12em',
          color: '#7a6a55',
          textTransform: 'uppercase',
          pointerEvents: 'none',
        }}
      >
        Drag to rotate · Scroll to zoom
      </div>
    </div>
  );
}

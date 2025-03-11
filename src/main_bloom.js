import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';


// Global variables
let scene, camera, renderer;
let markers = [];
let trails = [];
let markerData = []; // Array of 8 markers, each with an array of {x, y, z} for each sample
let currentSample = 0;
const maxTrailLength = 240; // number of positions in the trail

let bloomComposer, finalComposer;
const darkMaterial = new THREE.MeshBasicMaterial({ color: 'black' });
const materials = {};

function darkenNonBloomed(obj) {
  if (obj.isMesh && obj.layers.test(bloomLayer) === false) {
    materials[obj.uuid] = obj.material;
    obj.material = darkMaterial;
  }
}

function restoreMaterial(obj) {
  if (materials[obj.uuid]) {
    obj.material = materials[obj.uuid];
    delete materials[obj.uuid];
  }
}

const bloomLayer = new THREE.Layers();
bloomLayer.set(1);

function init() {
  // Create scene and set background to black
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // Set up camera
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 3;

  // Set up renderer
  renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // BLOOMPASS
  const renderScene = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1,  // bloom strength (adjust for brightness)
    0.1,  // bloom radius
    0.0  // bloom threshold
  );
  bloomComposer = new EffectComposer(renderer);
  bloomComposer.addPass(renderScene);
  bloomComposer.addPass(bloomPass);

  // SHADERPASS
  const finalPass = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(baseTexture, vUv);
          vec4 bloom = texture2D(bloomTexture, vUv);
          gl_FragColor = base + bloom;
        }
      `
    }),
    'baseTexture'
  );
  finalPass.needsSwap = true;

  finalComposer = new EffectComposer(renderer);
  finalComposer.addPass(new RenderPass(scene, camera));
  finalComposer.addPass(finalPass);


  // Load binary marker data files
  Promise.all([
    fetch('./markers8_x.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer)),
    fetch('./markers8_y.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer)),
    fetch('./markers8_z.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer))
  ]).then(([xData, yData, zData]) => {
    const markersCount = 8;
    const samples = xData.length / markersCount;

    // Reshape binary data: create an array for each marker with its sample positions
    for (let i = 0; i < markersCount; i++) {
      markerData[i] = [];
      for (let j = 0; j < samples; j++) {
        // const idx = i * samples + j; // assuming data is stored row-major ([markers, samples])
        const idx = j * markersCount + i; // assuming data is stored row-major ([markers, samples])
        markerData[i].push({ x: xData[idx], y: yData[idx], z: zData[idx] });
      }
    }

    // Create marker spheres and their trails
    for (let i = 0; i < markersCount; i++) {
      // Decide color based on marker group (markers 1-3 white, 4-8 green)
      const color = (i < 3) ? 0xffffff : 0x00ff00;

      // Create sphere geometry for the marker
      const sphereGeo = new THREE.SphereGeometry(0.02, 16, 16);
      const sphereMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75 });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      scene.add(sphere);
      markers.push(sphere);

      // Create a dynamic line for the trail using a custom shader material
      const trailGeo = new THREE.BufferGeometry();
      // Pre-allocate positions for the trail (maxTrailLength points, each with x,y,z)
      const positions = new Float32Array(maxTrailLength * 3);
      trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      // Pre-allocate the progress attribute (one float per vertex)
      const progressArray = new Float32Array(maxTrailLength);
      // Initialize the progress values to 0
      for (let k = 0; k < maxTrailLength; k++) {
        progressArray[k] = 0;
      }
      trailGeo.setAttribute('progress', new THREE.BufferAttribute(progressArray, 1));

      // Create a custom shader material for the trail.
      // The vertex shader passes the progress attribute to the fragment shader,
      // and the fragment shader uses it to taper brightness.
      const trailMat = new THREE.ShaderMaterial({
        uniforms: {
          baseColor: { value: new THREE.Color(color) }  // color is white (0xffffff) or green (0x00ff00)
        },
        vertexShader: `
          attribute float progress;
          varying float vProgress;
          void main() {
            vProgress = progress;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 baseColor;
          varying float vProgress;
          void main() {
            // Use smoothstep so that the brightness ramps up from 0 (oldest) to 1 (newest)
            float brightness = smoothstep(0.0, 1.0, vProgress);
            gl_FragColor = vec4(baseColor * brightness, brightness);
          }
        `,
        transparent: true,
        // Optional: Use additive blending to enhance the glowing effect.
        blending: THREE.AdditiveBlending,
        depthTest: false
      });

      // Create the trail line object and add it to the scene.
      const trailLine = new THREE.Line(trailGeo, trailMat);
      trailLine.layers.enable(1);
      scene.add(trailLine);

      // Store the trail for later updates.
      trails.push({
        line: trailLine,
        positions: positions,
        progress: progressArray,
        count: 0  // number of positions currently in the trail
      });




    }
  });

  window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);

  // Only update if the marker data has been loaded
  if (markerData.length > 0) {

    markers.forEach((marker, i) => {
      const data = markerData[i];
      const sampleIndex = currentSample % data.length;
      const pos = data[sampleIndex];
      marker.position.set(pos.x, pos.y, pos.z);
    
      // Update the corresponding trail:
      const trail = trails[i];
      const posArray = trail.positions;
      const progArray = trail.progress;
      const stride = 3; // x, y, z per point
    
      // Shift positions in the buffer (and their corresponding progress values)
      for (let j = 0; j < (trail.count - 1) * stride; j++) {
        posArray[j] = posArray[j + stride];
      }
      // Append the current position at the end of the valid trail segment
      const baseIndex = (trail.count - 1) * stride;
      posArray[baseIndex] = pos.x;
      posArray[baseIndex + 1] = pos.y;
      posArray[baseIndex + 2] = pos.z;
    
      // Increase the trail count until we reach the maximum
      if (trail.count < maxTrailLength) {
        trail.count++;
      }
    
      // Update the progress attribute so that the oldest point has 0 and the newest 1.
      // We simply assign a linear ramp from 0 to 1 across the current trail count.
      for (let j = 0; j < trail.count; j++) {
        progArray[j] = trail.count > 1 ? j / (trail.count - 1) : 1;
      }
    
      // Update the draw range and mark attributes as needing an update.
      trail.line.geometry.setDrawRange(0, trail.count);
      trail.line.geometry.attributes.position.needsUpdate = true;
      trail.line.geometry.attributes.progress.needsUpdate = true;
    });

    // Advance the sample index for the replay (adjust speed as desired)
    currentSample++;
  }

  // Render bloom pass
  scene.traverse(darkenNonBloomed);
  bloomComposer.render();
  scene.traverse(restoreMaterial);

  // Now composite the normal scene and bloom render together
  finalComposer.render();

}

// Initialize Three.js scene
init();
animate();

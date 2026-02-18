/**
 * WebGL2 instanced renderer for Manifest universe.
 * Replaces Canvas 2D with GPU-accelerated point sprites.
 *
 * TIER 2 IMPLEMENTATION - Use after Tier 1 is stable
 */

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      powerPreference: 'high-performance'
    });

    if (!this.gl) {
      throw new Error('WebGL2 not supported');
    }

    this.maxInstances = 100000;
    this.programs = {};
    this.buffers = {};
    this.textures = {};

    this.init();
  }

  init() {
    const gl = this.gl;

    // Enable blending for transparency
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Compile shaders
    this.programs.members = this.createProgram(
      this.vertexShaderSource(),
      this.fragmentShaderSource()
    );

    // Create instance buffers
    this.buffers.positions = this.createBuffer(new Float32Array(this.maxInstances * 3));
    this.buffers.colors = this.createBuffer(new Float32Array(this.maxInstances * 4));
    this.buffers.scales = this.createBuffer(new Float32Array(this.maxInstances));
    this.buffers.opacities = this.createBuffer(new Float32Array(this.maxInstances));

    // Create risk gradient texture (1D lookup)
    this.textures.riskGradient = this.createRiskGradientTexture();

    console.log('WebGL2 renderer initialized');
  }

  vertexShaderSource() {
    return `#version 300 es
      precision highp float;

      // Per-instance attributes
      in vec3 instancePosition;
      in vec4 instanceColor;
      in float instanceScale;
      in float instanceOpacity;

      // Uniforms
      uniform mat4 u_viewProjection;
      uniform vec3 u_cameraPosition;
      uniform float u_basePointSize;

      // Outputs to fragment shader
      out vec4 v_color;
      out float v_opacity;

      void main() {
        // World position
        vec4 worldPos = vec4(instancePosition, 1.0);
        gl_Position = u_viewProjection * worldPos;

        // Distance-based point size (LOD)
        float distance = length(u_cameraPosition - instancePosition);
        gl_PointSize = max(2.0, (u_basePointSize * instanceScale) / (1.0 + distance * 0.01));

        // Pass to fragment shader
        v_color = instanceColor;
        v_opacity = instanceOpacity;
      }
    `;
  }

  fragmentShaderSource() {
    return `#version 300 es
      precision highp float;

      // Inputs from vertex shader
      in vec4 v_color;
      in float v_opacity;

      // Output
      out vec4 fragColor;

      void main() {
        // Circular point sprite
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);

        if (dist > 0.5) discard;

        // Glow falloff
        float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
        alpha *= v_opacity;

        // Core brightness boost
        if (dist < 0.2) {
          alpha *= 1.5;
        }

        fragColor = vec4(v_color.rgb, alpha * v_color.a);
      }
    `;
  }

  createProgram(vertSource, fragSource) {
    const gl = this.gl;

    const vertShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertShader, vertSource);
    gl.compileShader(vertShader);

    if (!gl.getShaderParameter(vertShader, gl.COMPILE_STATUS)) {
      console.error('Vertex shader error:', gl.getShaderInfoLog(vertShader));
      throw new Error('Vertex shader compilation failed');
    }

    const fragShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragShader, fragSource);
    gl.compileShader(fragShader);

    if (!gl.getShaderParameter(fragShader, gl.COMPILE_STATUS)) {
      console.error('Fragment shader error:', gl.getShaderInfoLog(fragShader));
      throw new Error('Fragment shader compilation failed');
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      throw new Error('Program linking failed');
    }

    return program;
  }

  createBuffer(data) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    return buffer;
  }

  createRiskGradientTexture() {
    const gl = this.gl;
    const width = 256;
    const data = new Uint8Array(width * 4);

    // Generate gradient: white -> yellow -> orange -> red
    for (let i = 0; i < width; i++) {
      const t = i / (width - 1); // 0 to 1
      let r, g, b;

      if (t < 0.3) {
        // Low risk: white to yellow
        const s = t / 0.3;
        r = 255;
        g = 255;
        b = Math.floor(255 * (1 - s * 0.5));
      } else if (t < 0.6) {
        // Medium risk: yellow to orange
        const s = (t - 0.3) / 0.3;
        r = 255;
        g = Math.floor(255 * (1 - s * 0.4));
        b = Math.floor(128 * (1 - s));
      } else {
        // High risk: orange to red
        const s = (t - 0.6) / 0.4;
        r = 255;
        g = Math.floor(165 * (1 - s));
        b = 0;
      }

      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);

    return texture;
  }

  render(members, camera, predictions = null) {
    const gl = this.gl;

    // Resize canvas to match display size
    const displayWidth = this.canvas.clientWidth;
    const displayHeight = this.canvas.clientHeight;
    if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
      this.canvas.width = displayWidth;
      this.canvas.height = displayHeight;
      gl.viewport(0, 0, displayWidth, displayHeight);
    }

    // Clear
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Use program
    const program = this.programs.members;
    gl.useProgram(program);

    // Build instance data
    const positions = [];
    const colors = [];
    const scales = [];
    const opacities = [];

    members.forEach((member) => {
      if (!member.position) return;

      positions.push(member.position.x, member.position.y, member.position.z);

      // Risk-based color
      let r, g, b;
      if (predictions && predictions.has(member.id)) {
        const pred = predictions.get(member.id);
        const risk = pred.risk || 0;

        // Sample from gradient
        if (risk < 0.3) {
          r = 1.0; g = 1.0; b = 0.9;
        } else if (risk < 0.6) {
          const t = (risk - 0.3) / 0.3;
          r = 1.0;
          g = 1.0 - t * 0.4;
          b = 0.5 * (1 - t);
        } else {
          const t = (risk - 0.6) / 0.4;
          r = 1.0;
          g = 0.65 * (1 - t);
          b = 0;
        }
      } else {
        // Default: yellow-orange based on mass
        const intensity = Math.min((member.mass || 1) / 6, 1);
        r = 1.0;
        g = 0.6 + intensity * 0.3;
        b = 0.2 + intensity * 0.3;
      }

      colors.push(r, g, b, 1.0);
      scales.push(member.scale || 1.0);
      opacities.push(member.opacity || 0.9);
    });

    const instanceCount = positions.length / 3;
    if (instanceCount === 0) return;

    // Upload instance data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.positions);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(positions));

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.colors);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(colors));

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.scales);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(scales));

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.opacities);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(opacities));

    // Set up attributes
    const posLoc = gl.getAttribLocation(program, 'instancePosition');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.positions);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(posLoc, 1);

    const colorLoc = gl.getAttribLocation(program, 'instanceColor');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.colors);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(colorLoc, 1);

    const scaleLoc = gl.getAttribLocation(program, 'instanceScale');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.scales);
    gl.enableVertexAttribArray(scaleLoc);
    gl.vertexAttribPointer(scaleLoc, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(scaleLoc, 1);

    const opacityLoc = gl.getAttribLocation(program, 'instanceOpacity');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.opacities);
    gl.enableVertexAttribArray(opacityLoc);
    gl.vertexAttribPointer(opacityLoc, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(opacityLoc, 1);

    // Set uniforms
    const viewProj = this.computeViewProjection(camera, displayWidth, displayHeight);
    const vpLoc = gl.getUniformLocation(program, 'u_viewProjection');
    gl.uniformMatrix4fv(vpLoc, false, viewProj);

    const camPosLoc = gl.getUniformLocation(program, 'u_cameraPosition');
    gl.uniform3f(camPosLoc, camera.focus.x, camera.focus.y, camera.focus.z);

    const pointSizeLoc = gl.getUniformLocation(program, 'u_basePointSize');
    gl.uniform1f(pointSizeLoc, 50.0);

    // Draw all instances in single call
    gl.drawArraysInstanced(gl.POINTS, 0, 1, instanceCount);

    // Cleanup
    gl.vertexAttribDivisor(posLoc, 0);
    gl.vertexAttribDivisor(colorLoc, 0);
    gl.vertexAttribDivisor(scaleLoc, 0);
    gl.vertexAttribDivisor(opacityLoc, 0);
  }

  computeViewProjection(camera, width, height) {
    // Simplified: orthographic-like projection matching Canvas 2D
    const aspect = width / height;
    const zoom = 70 / Math.max(camera.d, 0.1);
    const scale = Math.min(width, height) * 0.009 * zoom;

    // Build view-projection matrix (simplified)
    const mat = new Float32Array(16);
    mat[0] = scale / width;
    mat[5] = scale / height;
    mat[10] = 0.001;
    mat[15] = 1;

    // TODO: Proper rotation from camera.rx, camera.ry
    // For now, identity rotation

    return mat;
  }

  dispose() {
    const gl = this.gl;

    Object.values(this.programs).forEach(p => gl.deleteProgram(p));
    Object.values(this.buffers).forEach(b => gl.deleteBuffer(b));
    Object.values(this.textures).forEach(t => gl.deleteTexture(t));

    console.log('WebGL2 renderer disposed');
  }
}

/**
 * Factory: Choose best available renderer
 */
export function createRenderer(canvas) {
  if (typeof WebGL2RenderingContext !== 'undefined') {
    try {
      return new WebGLRenderer(canvas);
    } catch (err) {
      console.warn('WebGL2 initialization failed, falling back to Canvas 2D:', err);
      return null; // Use existing Canvas 2D renderer
    }
  }

  console.warn('WebGL2 not supported, using Canvas 2D');
  return null;
}

// WebGPU Compatibility Check based on Microsoft's tutorial requirements
// Supports: Chrome 113+, Edge 113+, Safari 18 (macOS 15), Firefox Nightly

class WebGPUCompatibilityChecker {
    constructor() {
        this.browserInfo = this.detectBrowser();
        this.compatibilityStatus = this.checkCompatibility();
    }

    detectBrowser() {
        const userAgent = navigator.userAgent;
        
        if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
            const match = userAgent.match(/Chrome\/(\d+)/);
            return {
                name: 'Chrome',
                version: match ? parseInt(match[1]) : 0,
                engine: 'chromium'
            };
        } else if (userAgent.includes('Edg')) {
            const match = userAgent.match(/Edg\/(\d+)/);
            return {
                name: 'Edge',
                version: match ? parseInt(match[1]) : 0,
                engine: 'chromium'
            };
        } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
            // Safari version detection is complex, checking for macOS 15 would be ideal
            return {
                name: 'Safari',
                version: 0, // Would need more complex detection
                engine: 'webkit'
            };
        } else if (userAgent.includes('Firefox')) {
            const match = userAgent.match(/Firefox\/(\d+)/);
            return {
                name: 'Firefox',
                version: match ? parseInt(match[1]) : 0,
                engine: 'gecko'
            };
        }
        
        return { name: 'Unknown', version: 0, engine: 'unknown' };
    }

    checkCompatibility() {
        const { name, version, engine } = this.browserInfo;
        
        switch (engine) {
            case 'chromium':
                if ((name === 'Chrome' || name === 'Edge') && version >= 113) {
                    return {
                        supported: true,
                        level: 'full',
                        message: `✅ ${name} ${version} supports WebGPU`,
                        requiresFlags: false
                    };
                }
                return {
                    supported: false,
                    level: 'unsupported',
                    message: `❌ ${name} ${version} does not support WebGPU (requires 113+)`,
                    requiresFlags: false
                };
                
            case 'webkit':
                if (name === 'Safari') {
                    // Safari 18 on macOS 15 has native support
                    return {
                        supported: true,
                        level: 'experimental',
                        message: '⚠️ Safari WebGPU support requires macOS 15+',
                        requiresFlags: false
                    };
                }
                break;
                
            case 'gecko':
                return {
                    supported: true,
                    level: 'experimental',
                    message: '🧪 Firefox Nightly with dom.webgpu.enabled=true',
                    requiresFlags: true,
                    flagInstructions: 'Set dom.webgpu.enabled=true in about:config'
                };
                
            default:
                return {
                    supported: false,
                    level: 'unsupported',
                    message: '❌ Browser does not support WebGPU',
                    requiresFlags: false
                };
        }
        
        return {
            supported: false,
            level: 'unknown',
            message: '❓ WebGPU support unknown for this browser',
            requiresFlags: false
        };
    }

    async testWebGPUAvailability() {
        const compatibility = this.compatibilityStatus;
        
        if (!compatibility.supported) {
            return {
                available: false,
                reason: 'browser_unsupported',
                message: compatibility.message,
                flagInstructions: compatibility.flagInstructions
            };
        }

        // Microsoft's recommended WebGPU availability check
        if (!navigator.gpu) {
            return {
                available: false,
                reason: 'no_navigator_gpu',
                message: '❌ navigator.gpu not available',
                suggestion: 'Enable WebGPU flags if using Chrome/Edge'
            };
        }

        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return {
                    available: false,
                    reason: 'no_adapter',
                    message: '❌ WebGPU adapter not available',
                    suggestion: 'Check GPU drivers and WebGPU flags'
                };
            }

            // Collect detailed adapter information
            const adapterInfo = {
                vendor: adapter.vendor || 'unknown',
                architecture: adapter.architecture || 'unknown',
                device: adapter.device || 'unknown',
                description: adapter.description || 'unknown'
            };

            // Get adapter features and limits
            const features = Array.from(adapter.features || []);
            const limits = adapter.limits ? {
                maxTextureDimension1D: adapter.limits.maxTextureDimension1D,
                maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
                maxTextureDimension3D: adapter.limits.maxTextureDimension3D,
                maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers,
                maxBindGroups: adapter.limits.maxBindGroups,
                maxDynamicUniformBuffersPerPipelineLayout: adapter.limits.maxDynamicUniformBuffersPerPipelineLayout,
                maxDynamicStorageBuffersPerPipelineLayout: adapter.limits.maxDynamicStorageBuffersPerPipelineLayout,
                maxSampledTexturesPerShaderStage: adapter.limits.maxSampledTexturesPerShaderStage,
                maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
                maxStorageTexturesPerShaderStage: adapter.limits.maxStorageTexturesPerShaderStage,
                maxUniformBuffersPerShaderStage: adapter.limits.maxUniformBuffersPerShaderStage,
                maxUniformBufferBindingSize: adapter.limits.maxUniformBufferBindingSize,
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                maxBufferSize: adapter.limits.maxBufferSize,
                maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
                maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
                maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
                maxComputeWorkgroupSizeY: adapter.limits.maxComputeWorkgroupSizeY,
                maxComputeWorkgroupSizeZ: adapter.limits.maxComputeWorkgroupSizeZ,
                maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension
            } : {};

            // Test device creation with error handling
            let deviceInfo = null;
            try {
                const device = await adapter.requestDevice();
                deviceInfo = {
                    label: device.label || 'WebGPU Device',
                    features: Array.from(device.features || []),
                    limits: device.limits ? {
                        maxBindGroups: device.limits.maxBindGroups,
                        maxComputeWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
                        maxComputeWorkgroupSizeY: device.limits.maxComputeWorkgroupSizeY,
                        maxComputeWorkgroupSizeZ: device.limits.maxComputeWorkgroupSizeZ
                    } : {}
                };
                device.destroy(); // Clean up
            } catch (deviceError) {
                return {
                    available: false,
                    reason: 'device_creation_failed',
                    message: `❌ Device creation failed: ${deviceError.message}`,
                    error: deviceError.message,
                    adapterInfo
                };
            }

            return {
                available: true,
                reason: 'fully_supported',
                message: '✅ WebGPU is fully available and tested',
                adapter: adapterInfo,
                features,
                limits,
                device: deviceInfo
            };

        } catch (error) {
            return {
                available: false,
                reason: 'adapter_error',
                message: `❌ WebGPU error: ${error.message}`,
                error: error.message
            };
        }
    }

    generateReport() {
        return {
            browser: this.browserInfo,
            compatibility: this.compatibilityStatus,
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory || 'unknown'
        };
    }

    // ONNX Runtime specific WebGPU diagnostics
    async performONNXRuntimeDiagnostics() {
        const diagnostics = {
            webgpuAvailable: false,
            ortLoaded: false,
            ortVersion: 'unknown',
            wasmSupport: false,
            jsepSupport: false,
            recommendations: []
        };

        // Check WebGPU availability
        const webgpuTest = await this.testWebGPUAvailability();
        diagnostics.webgpuAvailable = webgpuTest.available;
        
        if (webgpuTest.available) {
            diagnostics.recommendations.push('✅ WebGPU is available - use webgpu execution provider');
        } else {
            diagnostics.recommendations.push('⚠️ WebGPU not available - fallback to wasm/cpu');
            diagnostics.recommendations.push(`Reason: ${webgpuTest.reason}`);
        }

        // Check if ONNX Runtime is loaded globally
        if (typeof window !== 'undefined' && window.ort) {
            diagnostics.ortLoaded = true;
            diagnostics.ortVersion = window.ort.version || 'unknown';
            
            // Check WASM configuration
            if (window.ort.env && window.ort.env.wasm) {
                diagnostics.wasmSupport = true;
                const wasmConfig = window.ort.env.wasm;
                
                // Check Microsoft's recommended settings
                if (wasmConfig.numThreads === 1) {
                    diagnostics.recommendations.push('✅ WASM numThreads set to 1 (WebGPU compatible)');
                } else {
                    diagnostics.recommendations.push('⚠️ Consider setting ort.env.wasm.numThreads = 1 for WebGPU compatibility');
                }
                
                if (wasmConfig.simd === true) {
                    diagnostics.recommendations.push('✅ WASM SIMD enabled (performance optimized)');
                } else {
                    diagnostics.recommendations.push('⚠️ Consider enabling ort.env.wasm.simd = true for better performance');
                }
                
                if (wasmConfig.wasmPaths) {
                    diagnostics.recommendations.push(`✅ WASM paths configured: ${wasmConfig.wasmPaths}`);
                } else {
                    diagnostics.recommendations.push('⚠️ WASM paths not configured - may cause loading issues');
                }
            }
        } else {
            diagnostics.recommendations.push('ℹ️ ONNX Runtime not loaded yet - diagnostics will update after loading');
        }

        // Check for JSEP file availability
        try {
            const jsepResponse = await fetch('/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs', { method: 'HEAD' });
            diagnostics.jsepSupport = jsepResponse.ok;
            
            if (jsepResponse.ok) {
                diagnostics.recommendations.push('✅ JSEP module available (enables WebGPU and WebNN)');
            } else {
                diagnostics.recommendations.push('⚠️ JSEP module not found - WebGPU may use single-threaded fallback');
            }
        } catch (e) {
            diagnostics.recommendations.push('⚠️ Unable to check JSEP availability');
        }

        return diagnostics;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WebGPUCompatibilityChecker;
} else if (typeof window !== 'undefined') {
    window.WebGPUCompatibilityChecker = WebGPUCompatibilityChecker;
}

// Auto-run check if in browser environment
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', async () => {
        const checker = new WebGPUCompatibilityChecker();
        const report = checker.generateReport();
        const availability = await checker.testWebGPUAvailability();
        const onnxDiagnostics = await checker.performONNXRuntimeDiagnostics();
        
        // Only log if there are issues or in development mode
        const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const hasIssues = !availability.available || !onnxDiagnostics.webgpuAvailable;
        
        if (isDev || hasIssues) {
            console.log(`🌐 WebGPU Status: ${availability.available ? '✅ Available' : '❌ Unavailable'} | Browser: ${report.browser.name} ${report.browser.version}`);
            
            if (hasIssues && onnxDiagnostics.recommendations.length > 0) {
                console.group('⚠️ WebGPU Issues:');
                onnxDiagnostics.recommendations.forEach(rec => console.log(rec));
                console.groupEnd();
            }
        }
        
        // Dispatch custom event with results
        window.dispatchEvent(new CustomEvent('webgpu-compatibility-check', {
            detail: { report, availability, onnxDiagnostics }
        }));
        
        // Store results globally for debugging
        window.webgpuDiagnostics = { report, availability, onnxDiagnostics };
    });
    
    // Silently update diagnostics after ONNX Runtime loads (no console output)
    setTimeout(async () => {
        if (typeof window.ort !== 'undefined') {
            const checker = new WebGPUCompatibilityChecker();
            const onnxDiagnostics = await checker.performONNXRuntimeDiagnostics();
            
            // Update global diagnostics silently
            if (window.webgpuDiagnostics) {
                window.webgpuDiagnostics.onnxDiagnosticsUpdated = onnxDiagnostics;
            }
        }
    }, 3000);
}
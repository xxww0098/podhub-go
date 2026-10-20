//! Browser-only bindgen and asynchronous adaptation.
use super::admission::{Peak, State, memory_bytes};
use super::compute::{self, Computed};
use super::error::{RuntimeError, byte_count, js_error};
use render::{ParsedTemplate, ProductResourcePolicy, RenderIntent};
use std::{cell::RefCell, rc::Rc, sync::Arc};
use wasm_bindgen::prelude::*;

/// All methods run on the responsive coordinator Worker. Awaiting Rayon yields
/// its event loop; disposing an owner never releases still-running compute.
#[wasm_bindgen]
pub struct RenderRuntime {
    state: Rc<RefCell<State>>,
}

#[wasm_bindgen]
impl RenderRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new(threads: u32, budget: f64) -> Result<RenderRuntime, JsValue> {
        let budget = byte_count(budget).map_err(js_error)?;
        if threads == 0 || threads as usize != rayon::current_num_threads() || budget == 0 {
            return Err(js_error(RuntimeError::Config));
        }
        Ok(Self {
            state: Rc::new(RefCell::new(State::new(threads as usize, budget))),
        })
    }
    pub async fn acquire(&self, owner: u32, key: String) -> Result<String, JsValue> {
        let receive = self
            .state
            .borrow_mut()
            .acquire(owner, key.clone())
            .map_err(js_error)?;
        let id = receive
            .await
            .map_err(|_| js_error(RuntimeError::Closed))?
            .map_err(js_error)?;
        let state = self.state.borrow();
        if !state.acquired(id, owner) {
            return Err(js_error(RuntimeError::Cancelled));
        }
        let template = state
            .template_id(&key)
            .map(|id| serde_json::json!({"sha256": key, "id": id}));
        Ok(serde_json::json!({"leaseId": id, "template": template}).to_string())
    }
    pub fn release(&self, id: u32) {
        self.state.borrow_mut().release(id);
    }
    pub fn dispose_owner(&self, owner: u32) {
        self.state.borrow_mut().dispose_owner(owner);
    }
    pub fn set_external_bytes(&self, bytes: f64) -> Result<(), JsValue> {
        self.state
            .borrow_mut()
            .set_external_bytes(byte_count(bytes).map_err(js_error)?);
        Ok(())
    }
    pub async fn retain_template(&self, lease: u32, bytes: Vec<u8>) -> Result<u32, JsValue> {
        let key = self.state.borrow_mut().start(lease).map_err(js_error)?;
        let retained = self.state.borrow().template_id(&key);
        if let Some(id) = retained {
            self.state.borrow_mut().finish(lease);
            return Ok(id);
        }
        let parsed = compute::run(&self.state, lease, &key, move || {
            ParsedTemplate::parse(&bytes, &ProductResourcePolicy::default())
                .map(|template| Computed {
                    value: Arc::new(template),
                    peak: None,
                })
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(js_error)?;
        self.state
            .borrow_mut()
            .retain_template(key, parsed)
            .map_err(js_error)
    }
    pub async fn render(
        &self,
        lease: u32,
        template_id: u32,
        design: Vec<u8>,
        name: String,
        intent: String,
    ) -> Result<Vec<u8>, JsValue> {
        let intent: RenderIntent = serde_json::from_str(&intent).map_err(js_error)?;
        let (key, template, unknown) = self
            .state
            .borrow_mut()
            .begin_render(lease, template_id)
            .map_err(js_error)?;
        compute::run(&self.state, lease, &key, move || {
            let outcome = render::render_product(
                &template,
                &design,
                &name,
                &intent,
                &ProductResourcePolicy::default(),
            )
            .map_err(|e| e.to_string())?;
            let observations = outcome.resource_observations;
            let working = observations.working_set_peak_bytes;
            let total = if unknown {
                memory_bytes().max(working)
            } else {
                working
            };
            let packed = crate::packing::pack(&outcome.manifest_json, &outcome.slices)?;
            Ok(Computed {
                value: packed,
                // Every lane of this template pays the working set again, but
                // only the first lane pays for the parsed document itself.
                peak: Some(Peak::new(total, observations.document_resident_bytes)),
            })
        })
        .await
        .map_err(js_error)
    }
    pub async fn prepare_image(&self, lease: u32, bytes: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let key = self.state.borrow_mut().start(lease).map_err(js_error)?;
        compute::run(&self.state, lease, &key, move || {
            render::prepare_ai_image(&bytes)
                .map(|value| Computed {
                    value,
                    // Decoding one AI image charges the whole runtime heap and
                    // no template geometry, so nothing here scales with lanes.
                    peak: Some(Peak::new(memory_bytes(), memory_bytes())),
                })
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(js_error)
    }
    pub fn measure(&self) -> String {
        self.state.borrow().measure()
    }
}
